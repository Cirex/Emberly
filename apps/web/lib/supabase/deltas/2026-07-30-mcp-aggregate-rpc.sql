-- ============================================================================
-- public.mcp_aggregate — do the GROUP BY in Postgres
-- ============================================================================
--
-- PostgREST cannot express GROUP BY, so the MCP server has been grouping in
-- application code. Every workaround it needed traces back to that one gap:
--
--   * group values were learned from a 5,000-row SAMPLE, because there was no
--     way to ask for the distinct set;
--   * counts ran ONE HEAD REQUEST PER GROUP, then reconciled against an exact
--     total and reported the shortfall as an "(other)" bucket, because a
--     sampled domain can miss a value;
--   * sum/avg/min/max pulled rows into the process under a 20,000-row cap and
--     had to flag `truncated`, because the alternative was pulling the table.
--
-- Measured on the live mirror, one grouped count over resman_transactions cost
-- 33 requests and 4.2 seconds. This function makes it one request, and makes
-- the numbers exact rather than exact-after-reconciliation.
--
-- SAFETY. The body builds dynamic SQL, so:
--   * p_table is checked against a fixed allowlist — the mirror tables the MCP
--     already exposes. Nothing else is reachable, including via a crafted name.
--   * every identifier goes through quote_ident and every value through
--     quote_literal, so neither a column name nor a filter value can break out
--     of the expression it sits in.
--   * SECURITY INVOKER (the default). This function must never be a way to read
--     a table the caller could not read directly; only the service role calls
--     it, and it should have exactly the service role's reach.
--   * search_path is pinned anyway, so unqualified references in the built SQL
--     cannot be captured by a shadowing object.
--   * EXECUTE is revoked from PUBLIC and granted to service_role only.

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
    'guest_passes', 'entry_logs', 'property_snapshots'
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
