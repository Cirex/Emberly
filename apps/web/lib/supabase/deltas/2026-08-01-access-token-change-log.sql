-- ============================================================================
-- public.access_token_changes — a trail for PERMISSION changes
-- ============================================================================
--
-- access_token_audit_log records what a token DID. Nothing recorded what was
-- done TO a token: minting, revoking, and — the one that exposed this — widening
-- its scopes. A token's access was changed from 13 resources to 16 during
-- development and the only record was a chat transcript.
--
-- A TRIGGER, not application code, and that is the whole point: the change that
-- revealed the gap was a direct UPDATE against the table. Anything that writes
-- through the API, through psql, or through a migration is caught here, because
-- the database is the one chokepoint none of them can go around.
--
-- Scopes are stored as before/after arrays rather than a diff, so a row answers
-- "what could this token reach on that date" without replaying history.

create table if not exists public.access_token_changes (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null,
  -- No FK: a token may be hard-deleted, and the trail of what it could once
  -- reach must outlive it. That is precisely when the record matters.
  label text,
  kind text,
  action text not null check (action in ('created', 'scopes_changed', 'revoked', 'reactivated', 'other')),
  scopes_before jsonb,
  scopes_after jsonb,
  active_before boolean,
  active_after boolean,
  changed_at timestamptz not null default now()
);

create index if not exists access_token_changes_token_idx
  on public.access_token_changes (token_id, changed_at desc);

create or replace function public.log_access_token_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    insert into public.access_token_changes (token_id, label, kind, action, scopes_after, active_after)
    values (new.id, new.label, new.kind, 'created', to_jsonb(new.scopes), new.active);
    return new;
  end if;

  -- Only permission-relevant transitions are logged. last_used_at is bumped on
  -- every authenticated request, and recording those here would bury the four
  -- events a year that actually matter under millions that do not.
  if new.scopes is distinct from old.scopes then
    v_action := 'scopes_changed';
  elsif old.active and not new.active then
    v_action := 'revoked';
  elsif not old.active and new.active then
    v_action := 'reactivated';
  else
    return new;
  end if;

  insert into public.access_token_changes (
    token_id, label, kind, action, scopes_before, scopes_after, active_before, active_after
  ) values (
    new.id, new.label, new.kind, v_action,
    to_jsonb(old.scopes), to_jsonb(new.scopes), old.active, new.active
  );
  return new;
end;
$$;

drop trigger if exists access_tokens_change_log on public.access_tokens;
create trigger access_tokens_change_log
  after insert or update on public.access_tokens
  for each row execute function public.log_access_token_change();

-- Backfill what is still knowable: current state for every existing token, so
-- the trail does not start with an unexplained gap. Marked 'other' rather than
-- 'created', because these are observations, not observed events.
insert into public.access_token_changes (token_id, label, kind, action, scopes_after, active_after, changed_at)
select id, label, kind, 'other', to_jsonb(scopes), active, coalesce(created_at, now())
from public.access_tokens
where not exists (
  select 1 from public.access_token_changes c where c.token_id = access_tokens.id
);

comment on table public.access_token_changes is
  'Permission changes to access_tokens (mint / scope change / revoke). Written by a TRIGGER so direct SQL is caught too — the gap that motivated it was a raw UPDATE.';
