-- ============================================================================
-- Drop resman_companies — this deployment will not be multi-tenant
-- ============================================================================
--
-- A config/tenant table: subdomain, account id, company name, and the derived
-- consumer/auth base URLs. It was ported from the Swift KrakenCore design
-- (ResManConfiguration / ResManCompany), which read the company row from the
-- database so one install could serve several ResMan accounts.
--
-- That is not how this was built. supabase/sync/src/resman/config.ts derives
-- the same values from ENV and never queries the table. The two files that
-- mention `resman_companies` mention it only in a docblock; their comments are
-- corrected in the same commit so the next reader does not go looking for a
-- table that is gone.
--
-- Verified against production before writing this:
--   * 0 rows — nothing to preserve, so no backup table
--   * no foreign keys point at it
--   * no function or view references it
--   * not exposed through the MCP server (absent from resman-resources.ts and
--     from the mcp_aggregate table allowlist)
--
-- Reversible by re-running the create block removed from schema.sql in the
-- same commit; with no rows there is nothing else to restore.

begin;

drop table if exists public.resman_companies;

commit;
