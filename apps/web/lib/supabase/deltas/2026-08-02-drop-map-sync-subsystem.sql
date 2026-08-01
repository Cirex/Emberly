-- ============================================================================
-- Drop the map-sync key subsystem — nothing could ever reach it
-- ============================================================================
--
-- There were two ways to write a map annotation:
--
--   A. POST /api/admin/map-annotations, guarded by requireAdminOrScanner. The
--      maintenance app sends its per-user staff token (eapi_…) and the security
--      app sends its scanner key. All 9 live annotations, 1 photo and 14 audit
--      rows arrived this way.
--
--   B. A device-enrolment handshake — request access, admin approves, device
--      claims a one-time code for a sync key — and a parallel annotations
--      endpoint under /api/map/properties/:id/. Built for an external XCMS
--      client, complete with tests and an admin screen.
--
-- B was never merely unused, it was UNREACHABLE: no client in this repo has any
-- request-access, claim-code or sync-key flow, so nothing could create the
-- first row. Both its tables held zero rows.
--
-- schema.sql said as much all along, next to map_annotations.layer:
--   "admin/scanner writers have no sync key, hence the nullable FK."
--
-- Order matters. The key columns on the three LIVE annotation tables are part
-- of composite foreign keys into map_sync_keys, so the constraints go first,
-- then the columns, then the tables. Verified before writing:
--   * map_sync_keys, map_sync_access_requests — 0 rows
--   * 0 live rows have any *_key_id set
--   * no code outside the removed routes names those columns
--
-- The scope columns (resman_account_id, property_id, feature_key) are KEPT.
-- They are not null and populated on every live row, and they discriminate the
-- one canvas all writers share — see MAP_SCOPE in lib/map-annotation-service.ts.

begin;

-- 1. Composite FKs into map_sync_keys, from tables that are staying.
alter table public.map_annotations
  drop constraint if exists map_annotations_created_key_scope_fkey,
  drop constraint if exists map_annotations_updated_key_scope_fkey,
  drop constraint if exists map_annotations_deleted_key_scope_fkey;

alter table public.map_annotation_photos
  drop constraint if exists map_annotation_photos_created_key_scope_fkey;

alter table public.map_annotation_audit_logs
  drop constraint if exists map_annotation_audit_logs_sync_key_scope_fkey;

-- 2. The columns those constraints existed for. Always null in practice —
--    only a sync key ever set them, and no sync key was ever issued.
alter table public.map_annotations
  drop column if exists created_by_key_id,
  drop column if exists updated_by_key_id,
  drop column if exists deleted_by_key_id;

alter table public.map_annotation_photos
  drop column if exists created_by_key_id;

alter table public.map_annotation_audit_logs
  drop column if exists sync_key_id;

-- 3. The subsystem itself.
drop table if exists public.map_sync_access_requests;
drop table if exists public.map_sync_keys;

commit;
