-- Utility layers: admit "internet" alongside the original five.
--
-- The utility layer shipped with a fixed set — water, sewer, gas, electrical,
-- other — enforced here so no client can write a type the map cannot draw.
-- Adding a layer therefore means widening the constraint in the same change as
-- the two client lists (apps/maintenance/lib/api/annotations.ts and
-- apps/web/lib/map-annotation-kinds.ts), or a device on the new build writes a
-- run the database rejects.
--
-- "electrical" deliberately KEEPS its name rather than becoming "power": it is
-- a persisted value on every existing run, and renaming it would need a data
-- migration to buy nothing but a shorter word.
--
-- Widening a CHECK is safe for existing rows — every current value still
-- satisfies the new predicate — so this needs no backfill and no downtime.

alter table public.map_annotations
  drop constraint if exists map_annotations_utility_type_check;

alter table public.map_annotations
  add constraint map_annotations_utility_type_check
  check (
    utility_type is null
    or utility_type in ('water', 'sewer', 'gas', 'electrical', 'internet', 'other')
  );
