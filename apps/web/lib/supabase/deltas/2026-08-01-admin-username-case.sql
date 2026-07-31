-- ============================================================================
-- admin_users.resman_username — one row per person, not one per spelling
-- ============================================================================
--
-- ResMan matches its staff usernames case-insensitively: the same person signs
-- in as `rdeojeda` one day and `Rdeojeda` the next and both succeed. We keyed
-- admin_users on the raw string and put a unique index on the raw string, so
-- the second spelling missed the lookup, passed the constraint, and inserted a
-- SECOND row for the same human — same ResMan person GUID, same display name,
-- its own id and its own role.
--
-- That is an authorization bug, not a cosmetic one. Roles are granted per row,
-- so whichever spelling someone happened to type decided which account, and
-- therefore which permissions, they logged into. Elevating `rdeojeda` to
-- property_manager would leave `Rdeojeda` a viewer, and nothing on the users
-- page would explain why the change appeared not to take.
--
-- Three steps, in this order: the index in step 3 cannot be created while
-- duplicates exist, and step 2 would violate the OLD index if two spellings
-- were still present.
--
-- Reversible: step 1 deletes rows, so take the backup below first if you want
-- an undo. Nothing references the deleted ids (checked: access_tokens,
-- access_token_audit_log, access_token_change_log, admin_audit_logs,
-- admin_alerts, map_annotation_audit_logs) — the merge preserves the surviving
-- row's id precisely so those references stay intact.

begin;

-- ---------------------------------------------------------------------------
-- 0. Keep a copy of what we are about to change. Drop it once satisfied.
-- ---------------------------------------------------------------------------
create table if not exists admin_users_case_merge_backup_20260801 as
  select * from admin_users;

-- ---------------------------------------------------------------------------
-- 1. Merge case-duplicates onto the OLDEST row for each username.
--
-- Oldest wins because it is the one the rest of the system already points at:
-- access tokens, audit rows and any granted role were attached to whichever row
-- existed first. The survivor inherits the newest last_login_at (so "last seen"
-- stays true) and the HIGHEST privilege held by any of its spellings (so a
-- deliberate grant is never silently revoked by this cleanup).
-- ---------------------------------------------------------------------------
with ranked as (
  select
    id,
    lower(resman_username) as canonical,
    row_number() over (
      partition by lower(resman_username)
      order by created_at asc, id asc
    ) as rn
  from admin_users
  where resman_username is not null
),
keepers as (select id, canonical from ranked where rn = 1),
merged as (
  select
    k.id as keep_id,
    max(a.last_login_at) as last_login_at,
    -- Most-privileged role across the duplicate set.
    (array_agg(a.role order by case a.role
       when 'super_admin' then 0
       when 'property_manager' then 1
       when 'security_manager' then 2
       else 3 end))[1] as role,
    bool_or(a.active) as active,
    max(a.display_name) filter (where a.display_name is not null) as display_name,
    max(a.resman_person_id) filter (where a.resman_person_id is not null) as resman_person_id
  from keepers k
  join ranked r on r.canonical = k.canonical
  join admin_users a on a.id = r.id
  group by k.id
)
update admin_users a
set last_login_at    = greatest(coalesce(a.last_login_at, m.last_login_at), m.last_login_at),
    role             = m.role,
    active           = m.active,
    display_name     = coalesce(a.display_name, m.display_name),
    resman_person_id = coalesce(a.resman_person_id, m.resman_person_id),
    updated_at       = now()
from merged m
where a.id = m.keep_id;

-- Now drop the losing spellings.
delete from admin_users a
using (
  select id from (
    select id, row_number() over (
      partition by lower(resman_username)
      order by created_at asc, id asc
    ) as rn
    from admin_users
    where resman_username is not null
  ) t where rn > 1
) dupes
where a.id = dupes.id;

-- ---------------------------------------------------------------------------
-- 2. Canonicalise what survives. Lowercase is the stored form; the raw input
--    still goes to ResMan for authentication, only our key is normalized.
-- ---------------------------------------------------------------------------
update admin_users
set resman_username = lower(resman_username),
    updated_at = now()
where resman_username is not null
  and resman_username <> lower(resman_username);

-- ---------------------------------------------------------------------------
-- 3. Make the collision impossible at the DATABASE, not just in the one code
--    path that happens to normalize today. A future insert that forgets to
--    lowercase now fails loudly instead of quietly forking someone's identity.
-- ---------------------------------------------------------------------------
drop index if exists admin_users_resman_username_idx;
create unique index admin_users_resman_username_idx
  on admin_users (lower(resman_username))
  where resman_username is not null;

commit;
