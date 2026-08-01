-- ============================================================================
-- Drop four columns nothing can read and nothing can write
-- ============================================================================
--
-- Emptiness is NOT the argument — a column is empty either because it is dead
-- or because the feature that fills it has not run yet. `guest_passes.used_at`
-- and `admin_alerts.resolved_at` are both empty and both very much alive.
--
-- What settles these four is that every query against their tables uses an
-- EXPLICIT column list; there is no `select("*")` anywhere in the codebase. So
-- each fails on both sides independently — no reader can surface it, and no
-- writer can fill it:
--
--   admin_users.key_hash
--       not in ADMIN_USER_COLUMNS (lib/admin-users.ts); no insert or update
--       sets it. Legacy of the retired shared ADMIN_LOGIN_KEY — admins
--       authenticate against the ResMan staff portal. Carries a stale UNIQUE
--       constraint, dropped with the column.
--
--   map_annotations.created_by_resman_login_hash
--   map_annotation_audit_logs.actor_resman_login_hash
--       not in the SELECT lists in lib/map-annotation-service.ts. Both were
--       written only by hashRequesterLogin() in lib/map-sync.ts, removed on
--       2026-08-02 with the unreachable sync-key path. Live until that commit;
--       dead since.
--
--   unit_tags.created_by_key_id
--       not in TAG_SELECT (lib/unit-tags.ts); the one insert in
--       app/api/admin/unit-tags/route.ts lists nine fields and not this. A
--       sync-key vestige that never had a foreign key.
--
-- None of these four tables is an MCP resource or in the mcp_aggregate table
-- allowlist, so there is no second door either. All four hold zero non-null
-- values, which is a symptom of the above rather than the reason for it.

begin;

alter table public.admin_users
  drop column if exists key_hash;

alter table public.map_annotations
  drop column if exists created_by_resman_login_hash;

alter table public.map_annotation_audit_logs
  drop column if exists actor_resman_login_hash;

alter table public.unit_tags
  drop column if exists created_by_key_id;

commit;
