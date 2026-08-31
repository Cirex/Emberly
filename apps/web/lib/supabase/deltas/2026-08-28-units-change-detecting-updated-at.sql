-- resman_units gets the CHANGE-DETECTING updated_at trigger, matching
-- resman_work_orders.
--
-- resman_units is a mirror table: the sync worker re-upserts all ~900 rows on
-- every pass. Under the shared unconditional trigger that meant every row's
-- updated_at moved on every pass, so updated_at recorded "the scraper last ran"
-- rather than "this row changed" — and a `updated_at > x` delta filter returned
-- the entire table, which is precisely the failure the touch_updated_at_on_change
-- docblock warns about.
--
-- The maintenance app polls the whole roster; it now reads it as a delta
-- (?updated_since=), which is only correct once updated_at means what it says.
-- `synced_at` is untouched and remains the "last scrape" provenance signal, so
-- nothing that asks when the scraper last ran is affected. No consumer filters
-- or orders resman_units by updated_at today, so this narrows a column's meaning
-- without changing any existing read.
drop trigger if exists resman_units_updated_at on public.resman_units;
create trigger resman_units_updated_at
  before update on public.resman_units
  for each row execute function public.touch_updated_at_on_change();

-- The delta read is (property, updated_at desc) — the same access path the
-- work-order delta already has an index for.
create index if not exists resman_units_property_updated_at_idx
  on public.resman_units (resman_property_id, updated_at desc);
