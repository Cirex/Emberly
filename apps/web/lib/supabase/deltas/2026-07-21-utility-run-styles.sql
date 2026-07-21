-- Per-run presentation for drawn utility polylines (kind='utility_line'):
-- line style, line weight, and flow-direction chevrons. All nullable with
-- rendering defaults in the clients, so rows created before this migration —
-- and writes from clients that predate it — keep working unchanged. The run's
-- label rides the existing `title` column; direction is the order of `points`
-- (reversing a run rewrites the array), so neither needs a column.

alter table public.map_annotations
  add column if not exists line_style text
    constraint map_annotations_line_style_check
    check (line_style is null or line_style in ('solid', 'dashed', 'dotted'));

alter table public.map_annotations
  add column if not exists line_weight text
    constraint map_annotations_line_weight_check
    check (line_weight is null or line_weight in ('thin', 'medium', 'thick'));

alter table public.map_annotations
  add column if not exists flow_arrows boolean;
