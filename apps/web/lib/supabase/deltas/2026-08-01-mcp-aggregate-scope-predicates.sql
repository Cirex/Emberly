-- ============================================================================
-- mcp_aggregate: richer scope predicates (in / neq / is_null) + an OR group
-- ============================================================================
--
-- Supersedes 2026-07-31-mcp-aggregate-monitor-findings.sql, left as it ran.
--
-- The canonical scopes could only say AND-of-equalities, which left exactly the
-- definitions people get wrong unexpressible: "open work order" is a SET of
-- statuses, "still open finding" is `resolved_at is null`, and "delinquent" is
-- a positive balance OR a stated reason. Those were documented as prose the
-- server could not enforce.
--
-- Predicate building moves into its own function so the AND list and the OR
-- group cannot drift apart — they are the same code, quoted the same way.

create or replace function public.mcp_predicate(p jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_col text := quote_ident(p ->> 'col');
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
      -- An empty IN list matches nothing. Say so explicitly rather than
      -- emitting `in ()`, which is a syntax error.
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

revoke all on function public.mcp_predicate(jsonb) from public;
grant execute on function public.mcp_predicate(jsonb) to service_role;

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
  p_search_term text default null
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
    v_where := v_where || ' and ' || public.mcp_predicate(v_filter);
  end loop;

  -- The OR group. ANDed as a single parenthesised clause, so a scope can only
  -- ever narrow — it can never pull in rows the other predicates excluded.
  if jsonb_array_length(coalesce(p_any, '[]'::jsonb)) > 0 then
    select string_agg(public.mcp_predicate(elem), ' or ')
      into v_any
      from jsonb_array_elements(p_any) as elem;
    v_where := v_where || format(' and (%s)', v_any);
  end if;

  -- Search is one OR group ANDed with everything else, so a term can never
  -- widen the result past the filters — the same rule the REST path follows.
  if p_search_term is not null and p_search_columns is not null
     and array_length(p_search_columns, 1) > 0 then
    select string_agg(format('%s ilike %L', quote_ident(c), '%' || p_search_term || '%'), ' or ')
      into v_search
      from unnest(p_search_columns) as c;
    v_where := v_where || format(' and (%s)', v_search);
  end if;

  -- --- grouping -----------------------------------------------------------
  if p_group_by is not null then
    v_grp := format('%s::text', quote_ident(p_group_by));
  end if;

  if p_period_column is not null then
    if p_period_interval not in ('day', 'week', 'month', 'quarter', 'year') then
      raise exception 'mcp_aggregate: unknown interval %', p_period_interval;
    end if;
    -- date_trunc('week') starts Monday, matching the application's ISO weeks.
    v_trunc := case
      when p_period_tz is null
        then format('date_trunc(%L, %s::timestamp)', p_period_interval, quote_ident(p_period_column))
        else format('date_trunc(%L, %s at time zone %L)', p_period_interval, quote_ident(p_period_column), p_period_tz)
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
    v_agg := format('%s(%s::numeric)', p_metric, quote_ident(p_measure));
    v_n   := format('count(%s)', quote_ident(p_measure));
  end if;

  v_sql := format(
    'select %s as grp, %s as period, %s as n, %s as val from %I where %s group by 1, 2',
    v_grp, v_period, v_n, v_agg, p_table, v_where
  );
  return query execute v_sql;
end;
$$;

revoke all on function public.mcp_aggregate(
  text, text, text, text, text, text, text, jsonb, jsonb, text[], text
) from public;
grant execute on function public.mcp_aggregate(
  text, text, text, text, text, text, text, jsonb, jsonb, text[], text
) to service_role;

comment on function public.mcp_aggregate(text, text, text, text, text, text, text, jsonb, jsonb, text[], text) is
  'Grouped aggregate for the MCP server. Table is allowlisted; identifiers are quote_ident''d and values quote_literal''d. SECURITY INVOKER by design.';
