-- ============================================================================
-- public.mcp_distincts — exact distinct values, one request
-- ============================================================================
--
-- describe_resource learns each groupable column's domain by paging a
-- 5,000-row SAMPLE: 7 requests and ~580ms on transactions, and 5,000 rows over
-- the wire to compute a handful of counts.
--
-- Worse than the cost, it was a SAMPLE. A rare value outside it simply had no
-- bucket, which reads exactly like a real zero — the failure describe_resource
-- exists to prevent. The application compensated with an "(other)" bucket and a
-- domain_complete flag, both of which are workarounds for not being able to ask
-- the question properly. GROUP BY answers it exactly, for every column at once.

create or replace function public.mcp_distincts(
  p_table text,
  p_columns text[],
  p_cap integer default 25
)
returns table (col text, val text, n bigint)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_allowed constant text[] := array[
    'resman_properties', 'resman_buildings', 'resman_floorplans', 'resman_units',
    'resman_leases', 'resman_residents', 'resman_transactions', 'resman_work_orders',
    'mlgw_accounts', 'mlgw_bills', 'mlgw_payments',
    'guest_passes', 'entry_logs', 'property_snapshots', 'unit_snapshots',
    'monitor_findings'
  ];
  v_parts text[] := '{}';
  v_col text;
begin
  if not (p_table = any (v_allowed)) then
    raise exception 'mcp_distincts: table % is not readable', p_table;
  end if;
  if p_columns is null or array_length(p_columns, 1) is null then
    return;
  end if;

  -- One UNION ALL branch per column, each already ranked and capped, so the
  -- whole domain of every groupable column comes back in a single round trip.
  foreach v_col in array p_columns loop
    v_parts := v_parts || format(
      '(select %L::text as col, %I::text as val, count(*) as n from %I group by 2 order by 3 desc limit %s)',
      v_col, v_col, p_table, greatest(p_cap, 1)
    );
  end loop;

  return query execute array_to_string(v_parts, ' union all ');
end;
$$;

revoke all on function public.mcp_distincts(text, text[], integer) from public;
grant execute on function public.mcp_distincts(text, text[], integer) to service_role;

comment on function public.mcp_distincts(text, text[], integer) is
  'Exact distinct values + counts for several columns in one query. Replaces a paged 5,000-row sample, so a rare value can no longer be missing from a reported domain.';
