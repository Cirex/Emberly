-- ============================================================================
-- mcp_predicate: add ilike_contains
-- ============================================================================
--
-- A related filter can now carry a SEARCH ("leases where a resident is named
-- X"), and with the EXISTS clause that search has to be expressible in SQL
-- rather than as a PostgREST embedded or(). One op, quoted like every other.
--
-- Replaces only mcp_predicate; mcp_aggregate calls it by name and is untouched.

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
  elsif v_op = 'ilike_contains' then
    -- The caller's term is already stripped of the characters that would break
    -- a PostgREST or= clause; quote_literal handles the rest. % and _ are LIKE
    -- metacharacters, so they are escaped to stay literal — otherwise a term
    -- containing one silently matches far more than the caller asked for.
    return format('%s ilike %L', v_col,
      '%' || replace(replace(p ->> 'val', '%', '\%'), '_', '\_') || '%');
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
