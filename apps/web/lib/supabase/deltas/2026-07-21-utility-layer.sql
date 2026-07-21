-- Utility layer for map annotations: utility pins and drawn polylines
-- (sewer/water/gas runs) on a shared 'utility' layer visible to both the
-- staff and security surfaces. Brings a database matching the pre-utility
-- schema.sql up to the new shape.

alter table public.map_annotations
  add column if not exists kind text not null default 'pin'
    constraint map_annotations_kind_check check (kind in ('pin', 'utility_pin', 'utility_line'));

alter table public.map_annotations
  add column if not exists utility_type text
    constraint map_annotations_utility_type_check
    check (utility_type is null or utility_type in ('water', 'sewer', 'gas', 'electrical', 'other'));

alter table public.map_annotations
  add column if not exists points jsonb;

alter table public.map_annotations
  drop constraint if exists map_annotations_layer_check;

alter table public.map_annotations
  add constraint map_annotations_layer_check check (layer in ('staff', 'security', 'utility'));
