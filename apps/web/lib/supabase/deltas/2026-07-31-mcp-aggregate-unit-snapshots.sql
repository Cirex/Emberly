-- ============================================================================
-- mcp_aggregate: allow unit_snapshots
-- ============================================================================
--
-- Supersedes 2026-07-30-mcp-aggregate-rpc.sql, which is already applied and is
-- therefore left exactly as it ran. The only change is the table allowlist:
-- public.unit_snapshots (per-unit daily history) did not exist when that
-- migration was written, so aggregating it was refused.
--
-- The body is otherwise identical; see the original for the safety rationale.

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
  -- [{"col": "...", "op": "eq|gte|lte", "val": "..."}]
  p_filters jsonb default '[]'::jsonb,
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
    'guest_passes', 'entry_logs', 'property_snapshots', 'unit_snapshots'
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
  v_col     text;
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
    v_col := quote_ident(v_filter ->> 'col');
    if v_filter ->> 'op' = 'eq' then
      v_where := v_where || format(' and %s = %L', v_col, v_filter ->> 'val');
    elsif v_filter ->> 'op' = 'gte' then
      v_where := v_where || format(' and %s >= %L', v_col, v_filter ->> 'val');
    elsif v_filter ->> 'op' = 'lte' then
      v_where := v_where || format(' and %s <= %L', v_col, v_filter ->> 'val');
    else
      raise exception 'mcp_aggregate: unknown filter op %', v_filter ->> 'op';
    end if;
  end loop;

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
  text, text, text, text, text, text, text, jsonb, text[], text
) from public;
grant execute on function public.mcp_aggregate(
  text, text, text, text, text, text, text, jsonb, text[], text
) to service_role;

comment on function public.mcp_aggregate(text, text, text, text, text, text, text, jsonb, text[], text) is
  'Grouped aggregate for the MCP server. Table is allowlisted; identifiers are quote_ident''d and values quote_literal''d. SECURITY INVOKER by design.';
