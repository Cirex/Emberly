-- Owner reports: monthly owner-report archive.
--
-- The sync worker's monthly job (supabase/sync/src/run-owner-report.ts,
-- `sync:owner-report`, scheduled by Coolify on the 1st) renders last month's
-- report through the MLGW Chromium pipeline and stores three objects per
-- period: <YYYY-MM>.pdf, <YYYY-MM>.html, and <YYYY-MM>.json — the frozen
-- ReportFigures payload ("report numbers freeze": July's report still says
-- what it said even after late payments land in August). The manager app
-- lists and streams them via /api/resman/manager/reports.
--
-- No new tables — the bucket listing is the archive index.
--
-- STORAGE BUCKET: provisioned via `insert into storage.buckets`, the same SQL
-- pattern schema.sql uses for `entry-log-photos`, `mlgw-bills`, and
-- `work-order-photos`. If this delta is applied with a role that cannot write
-- storage.buckets, create the bucket in the Supabase dashboard instead:
-- name `owner-reports`, private.

insert into storage.buckets (id, name, public)
values ('owner-reports', 'owner-reports', false)
on conflict (id) do update
set public = excluded.public;
