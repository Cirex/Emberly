-- ============================================================================
-- Lock down public.check_rate_limit
-- ============================================================================
--
-- Live state before this migration:
--   prosecdef = true          (SECURITY DEFINER, owned by postgres)
--   proconfig = null          (NO search_path pinned)
--   acl       = =X/postgres | postgres=X | anon=X | authenticated=X | service_role=X
--
-- `=X/postgres` is PUBLIC EXECUTE. Two problems follow.
--
-- 1. LOCKOUT. This is the rate limiter for admin sign-in, the app-token
--    exchange, resident verification and the ResMan API. Its whole contract is
--    "call me and I'll count you". Anything that can execute it can therefore
--    burn any bucket it can name, and the bucket names are derived from public
--    inputs (`admin-app-login:<ip>`, `resman-api:<ip>`). A caller holding only
--    the publishable anon key could push a bucket past its ceiling and hold the
--    real user out for the whole window — and each call also WRITES to
--    rate_limits as postgres, since the function is SECURITY DEFINER.
--
--    The only legitimate caller is the server: lib/rate-limit.ts invokes it via
--    createAdminClient() (service role). Nothing in any client bundle calls it.
--
-- 2. UNPINNED search_path ON A DEFINER FUNCTION. The body's unqualified
--    references (rate_limits, now(), make_interval) resolve through the
--    CALLER's search_path while executing as the owner — the standard
--    search_path-hijack shape. Pinning it removes the question entirely rather
--    than relying on the caller being unable to create shadowing objects.
--
-- The body is unchanged; this replaces the function only to attach the setting.

create or replace function public.check_rate_limit(
  p_bucket text,
  p_max_attempts integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
-- pg_temp last, and explicitly, so a temp object can never shadow a real one.
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_row rate_limits%rowtype;
begin
  insert into rate_limits (bucket, window_start, count, expires_at, updated_at)
  values (p_bucket, v_now, 1, v_now + make_interval(secs => p_window_seconds), v_now)
  on conflict (bucket) do update
    set window_start = case
          when rate_limits.expires_at <= v_now then v_now
          else rate_limits.window_start
        end,
        count = case
          when rate_limits.expires_at <= v_now then 1
          else rate_limits.count + 1
        end,
        expires_at = case
          when rate_limits.expires_at <= v_now then v_now + make_interval(secs => p_window_seconds)
          else rate_limits.expires_at
        end,
        updated_at = v_now
  returning * into v_row;

  return v_row.count <= p_max_attempts;
end;
$$;

-- Server-only. `create or replace` preserves the existing ACL, so the revokes
-- have to be explicit.
revoke all on function public.check_rate_limit(text, integer, integer) from public;
revoke all on function public.check_rate_limit(text, integer, integer) from anon;
revoke all on function public.check_rate_limit(text, integer, integer) from authenticated;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;

comment on function public.check_rate_limit(text, integer, integer) is
  'Fixed-window rate limiter. SECURITY DEFINER with a pinned search_path; '
  'EXECUTE is service_role only — a caller that can name a bucket can lock it.';
