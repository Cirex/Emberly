-- ============================================================================
-- Make resman_work_orders.updated_at mean "this work order changed"
-- ============================================================================
--
-- WHY. The maintenance app needs to know what changed since it last looked, so
-- a phone can poll cheaply (and be pushed at) instead of re-downloading the
-- whole board every 60 seconds. `updated_at` looks like the column for that
-- and is currently useless for it:
--
--   * public.update_updated_at_column() sets updated_at = now() unconditionally
--     on every UPDATE, and
--   * the sync worker's upsertMirror() rewrites EVERY scraped row on EVERY
--     pass (that is what makes it idempotent).
--
-- So every work order gets a fresh updated_at every few minutes whether or not
-- anything about it moved. `?updated_since=` would return the entire table on
-- every poll, and a change-detection pass in the sync would report all N rows
-- as changed and push a notification for each.
--
-- WHAT. A dedicated trigger function that only advances updated_at when the row
-- actually differs. Deliberately NOT a change to update_updated_at_column() —
-- that function is shared by many tables, and re-pointing one trigger is a much
-- smaller blast radius than changing the semantics of all of them.
--
-- The comparison ignores two columns:
--   updated_at — set by this trigger; including it would compare a value
--                against the one being computed.
--   synced_at  — provenance ("the scraper saw this row"), not content. The
--                work-orders job does not currently write it, but excluding it
--                means a future job that does can't defeat the guard.
--
-- `raw` IS compared. It is built deterministically from the CSV row
-- (jobs/work-orders.ts) with no timestamps folded in, so it differs only when
-- the report differs — which is a real change.
--
-- Idempotent and reversible: re-point the trigger back at
-- update_updated_at_column() to undo. No data is modified.

create or replace function public.touch_updated_at_on_change()
returns trigger as $$
begin
  if to_jsonb(new) - 'updated_at' - 'synced_at'
     = to_jsonb(old) - 'updated_at' - 'synced_at' then
    -- Nothing moved: hold the timestamp so "changed since X" stays truthful
    -- across an idempotent mirror re-upsert.
    new.updated_at = old.updated_at;
    return new;
  end if;
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

comment on function public.touch_updated_at_on_change() is
  'Advances updated_at only when the row actually changed, ignoring updated_at '
  'and synced_at. For mirror tables whose sync re-upserts every row each pass.';

drop trigger if exists resman_work_orders_updated_at on public.resman_work_orders;
create trigger resman_work_orders_updated_at
  before update on public.resman_work_orders
  for each row execute function public.touch_updated_at_on_change();

-- The delta read is (property, updated_at) — without this it is a seq scan on
-- every poll from every device.
create index if not exists resman_work_orders_property_updated_at_idx
  on public.resman_work_orders (resman_property_id, updated_at desc);
