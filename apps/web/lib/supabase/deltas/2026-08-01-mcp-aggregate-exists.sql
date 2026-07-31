-- ============================================================================
-- mcp_aggregate: cross-resource EXISTS, so a related filter stays in SQL
-- ============================================================================
--
-- Supersedes 2026-08-01-mcp-aggregate-scope-predicates.sql, left as it ran.
--
-- A `related` filter previously forced the whole aggregate onto the PostgREST
-- path, because a join is not something this function could express. Measured:
-- units grouped by building with an open work order cost 29 requests and
-- 3.7 SECONDS — one HEAD count per building, sequentially. That is the exact
-- pathology the RPC was written to kill, reappearing through a side door.
--
-- p_exists adds `[not] exists (select 1 from child c where c.fk = t.pk and …)`.
-- The outer table is now aliased `t` and every predicate is qualified, which
-- matters more than it looks: an unqualified child predicate naming a column
-- the child does not have would bind to the OUTER row and silently filter the
-- wrong table.

create or replace function public.mcp_predicate(p jsonb, p_prefix text default '')
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_col text := case when p_prefix = '' then quote_ident(p ->> 'col')
                     else quote_ident(p_prefix) || '.' || quote_ident(p ->> 'col') end;
  v_op  text := p ->> 'op';
  v_vals text;
begin
  if v_op = 'eq' then      return format('%s = %L', v_col, p ->> 'val');
  elsif v_op = 'neq' then  return format('%s <> %L', v_col, p ->> 'val');
  elsif v_op = 'gte' then  return format('%s >= %L', v_col, p ->> 'val');
  elsif v_op = 'lte' then  return format('%s <= %L', v_col, p ->> 'val');
  elsif v_op = 'is_null' then  return format('%s is null', v_col);
  elsif v_op = 'not_null' then return format('%s is not null', v_col);
  elsif v_op = 'in' then
    if p -> 'vals' is null or jsonb_array_length(p -> 'vals') = 0 then
      return 'false';
    end if;
    select string_agg(quote_literal(value), ', ') into v_vals
      from jsonb_array_elements_text(p -> 'vals');
    return format('%s in (%s)', v_col, v_vals);
  else
    raise exception 'mcp_aggregate: unknown filter op %', v_op;
  end if;
end;
$$;

revoke all on function public.mcp_predicate(jsonb, text) from public;
grant execute on function public.mcp_predicate(jsonb, text) to service_role;

create or replace function public.mcp_aggregate(
  p_table text,
  p_group_by text default null,
  p_period_column text default null,
  p_period_interval text default null,
  -- Non-null means the period column is an INSTANT and must be read in this
  -- zone. Null means a plain DATE, which carries no timezone and must not be
  -- converted — the same date/timestamp split the application layer makes.
  p_period_tz text default null,
  p_metric text default 'count',
  p_measure text default null,
  -- [{"col":"…","op":"eq|neq|gte|lte|in|is_null|not_null","val":"…","vals":[…]}]
  p_filters jsonb default '[]'::jsonb,
  -- Same shape, OR'd together and ANDed with everything else. One group only.
  p_any jsonb default '[]'::jsonb,
  p_search_columns text[] default null,
  p_search_term text default null,
  -- {"table":"…","parent_key":"…","child_key":"…","negate":bool,"filters":[…],"any":[…]}
  -- A cross-resource filter. Previously this forced the whole aggregate onto
  -- the PostgREST path, where a grouped count cost one HEAD request per group
  -- — 29 requests and 3.7s for units-by-building with an open work order.
  p_exists jsonb default null
)
returns table (grp text, period text, n bigint, val numeric)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_allowed constant text[] := array[
    'resman_properties', 'resman_buildings', 'resman_floorplans', 'resman_units',
    'resman_leases', 'resman_residents', 'resman_transactions', 'resman_work_orders',
    'mlgw_accounts', 'mlgw_bills', 'mlgw_payments',
    'guest_passes', 'entry_logs', 'property_snapshots', 'unit_snapshots', 'monitor_findings'
  ];
  v_where   text := 'true';
  v_grp     text := 'null::text';
  v_period  text := 'null::text';
  v_trunc   text;
  v_label   text;
  v_agg     text;
  v_n       text;
  v_search  text := '';
  v_filter  jsonb;
  v_any     text;
  v_exists  text;
  v_child   jsonb;
  v_sql     text;
begin
  if not (p_table = any (v_allowed)) then
    raise exception 'mcp_aggregate: table % is not aggregatable', p_table;
  end if;
  if p_metric not in ('count', 'sum', 'avg', 'min', 'max') then
    raise exception 'mcp_aggregate: unknown metric %', p_metric;
  end if;
  if p_metric <> 'count' and p_measure is null then
    raise exception 'mcp_aggregate: metric % requires a measure', p_metric;
  end if;

  -- --- predicates ---------------------------------------------------------
  for v_filter in select * from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb))
  loop
    v_where := v_where || ' and ' || public.mcp_predicate(v_filter, 't');
  end loop;

  -- The OR group. ANDed as a single parenthesised clause, so a scope can only
  -- ever narrow — it can never pull in rows the other predicates excluded.
  if jsonb_array_length(coalesce(p_any, '[]'::jsonb)) > 0 then
    select string_agg(public.mcp_predicate(elem, 't'), ' or ')
      into v_any
      from jsonb_array_elements(p_any) as elem;
    v_where := v_where || format(' and (%s)', v_any);
  end if;

  -- --- cross-resource filter ----------------------------------------------
  -- Child predicates are prefixed with the child alias `c`, never left bare:
  -- an unqualified name that the child lacks would silently bind to the OUTER
  -- row and quietly filter the wrong table.
  if p_exists is not null then
    if not (p_exists ->> 'table' = any (v_allowed)) then
      raise exception 'mcp_aggregate: related table % is not aggregatable', p_exists ->> 'table';
    end if;
    v_exists := format(
      'select 1 from %I as c where c.%I = t.%I',
      p_exists ->> 'table', p_exists ->> 'child_key', p_exists ->> 'parent_key'
    );
    for v_child in select * from jsonb_array_elements(coalesce(p_exists -> 'filters', '[]'::jsonb))
    loop
      v_exists := v_exists || ' and ' || public.mcp_predicate(v_child, 'c');
    end loop;
    if jsonb_array_length(coalesce(p_exists -> 'any', '[]'::jsonb)) > 0 then
      select string_agg(public.mcp_predicate(elem, 'c'), ' or ')
        into v_any
        from jsonb_array_elements(p_exists -> 'any') as elem;
      v_exists := v_exists || format(' and (%s)', v_any);
    end if;
    v_where := v_where || format(
      ' and %s exists (%s)',
      case when coalesce((p_exists ->> 'negate')::boolean, false) then 'not' else '' end,
      v_exists
    );
  end if;

  -- Search is one OR group ANDed with everything else, so a term can never
  -- widen the result past the filters — the same rule the REST path follows.
  if p_search_term is not null and p_search_columns is not null
     and array_length(p_search_columns, 1) > 0 then
    select string_agg(format('t.%s ilike %L', quote_ident(c), '%' || p_search_term || '%'), ' or ')
      into v_search
      from unnest(p_search_columns) as c;
    v_where := v_where || format(' and (%s)', v_search);
  end if;

  -- --- grouping -----------------------------------------------------------
  if p_group_by is not null then
    v_grp := format('t.%s::text', quote_ident(p_group_by));
  end if;

  if p_period_column is not null then
    if p_period_interval not in ('day', 'week', 'month', 'quarter', 'year') then
      raise exception 'mcp_aggregate: unknown interval %', p_period_interval;
    end if;
    -- date_trunc('week') starts Monday, matching the application's ISO weeks.
    v_trunc := case
      when p_period_tz is null
        then format('date_trunc(%L, %s::timestamp)', p_period_interval, 't.' || quote_ident(p_period_column))
        else format('date_trunc(%L, %s at time zone %L)', p_period_interval, 't.' || quote_ident(p_period_column), p_period_tz)
    end;
    v_label := case p_period_interval
      when 'day'     then 'YYYY-MM-DD'
      when 'week'    then 'YYYY-MM-DD'
      when 'month'   then 'YYYY-MM'
      when 'quarter' then 'YYYY"-Q"Q'
      when 'year'    then 'YYYY'
    end;
    v_period := format('to_char(%s, %L)', v_trunc, v_label);
  end if;

  -- --- measure ------------------------------------------------------------
  if p_metric = 'count' then
    v_agg := 'null::numeric';
    v_n   := 'count(*)';
  else
    -- SQL aggregates already ignore NULLs, which is the semantics the
    -- application had to hand-roll: Number(null) is 0, not NaN, so a missing
    -- value would otherwise land as a real zero and halve an average.
    v_agg := format('%s(t.%s::numeric)', p_metric, quote_ident(p_measure));
    v_n   := format('count(t.%s)', quote_ident(p_measure));
  end if;

  v_sql := format(
    'select %s as grp, %s as period, %s as n, %s as val from %I as t where %s group by 1, 2',
    v_grp, v_period, v_n, v_agg, p_table, v_where
  );
  return query execute v_sql;
end;
$$;

revoke all on function public.mcp_aggregate(
  text, text, text, text, text, text, text, jsonb, jsonb, text[], text, jsonb
) from public;
grant execute on function public.mcp_aggregate(
  text, text, text, text, text, text, text, jsonb, jsonb, text[], text, jsonb
) to service_role;

comment on function public.mcp_aggregate(text, text, text, text, text, text, text, jsonb, jsonb, text[], text, jsonb) is
  'Grouped aggregate for the MCP server. Table is allowlisted; identifiers are quote_ident''d and values quote_literal''d. SECURITY INVOKER by design.';
