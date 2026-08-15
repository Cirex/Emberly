-- Capture the two Vehicles-tab fields the scraper parsed and then dropped.
--
-- An audit of every mirrored column for the "100% empty table-wide" signature
-- flagged resman_lease_vehicles.parking_spot: 0 of 721 rows. The mapper read
-- "Parking Spot" / "Parking" keys, and the Vehicles tab
-- (/Automobiles/Detail?leaseID=…) has no parking-space column at all. Its
-- columns are, verbatim: Year, Make - Model, Owner, Color, License plate,
-- Permit number, plus a full-width Notes row.
--
-- So parking_spot cannot be filled from ResMan — but two real fields were being
-- thrown away next to it:
--
--   permit_number  the parking DECAL number ("0625"). This is the closest thing
--                  ResMan holds to parking data and the field the empty
--                  parking_spot column was evidently reaching for. Towing and
--                  permit enforcement need it; it lives only on this tab.
--   notes          free text, on 107 of 399 vehicles seen. Overwhelmingly decal
--                  history ("P/U decal 04/16/2025 Update 0625") — the audit
--                  trail behind permit_number.
--
-- parking_spot is left in place, still empty, rather than dropped: dropping a
-- column is irreversible and no consumer reads it. See docs/Database.md, where
-- it is now marked as not available from ResMan.

alter table public.resman_lease_vehicles
  add column if not exists permit_number text not null default '',
  add column if not exists notes text not null default '';

comment on column public.resman_lease_vehicles.permit_number is
  'Parking decal number from the ResMan Vehicles tab ("Permit number").';
comment on column public.resman_lease_vehicles.notes is
  'Free-text note from the ResMan Vehicles tab; usually decal history.';
comment on column public.resman_lease_vehicles.parking_spot is
  'Always empty — ResMan has no parking-space field. See permit_number.';
