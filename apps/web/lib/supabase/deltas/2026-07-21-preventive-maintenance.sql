-- Emberly-owned preventive maintenance (PM). Admins define templates
-- (pm_templates); the sync worker expands active templates into per-unit task
-- "rounds" nightly and idempotently (pm_tasks). ResMan is never written.
-- Brings a database matching the pre-PM schema.sql up to the new shape.
-- Service-role only (RLS on, no policies), like the rest of the first-party
-- tables.

-- ------------------------------------------------------------
-- pm_templates — admin-defined recurring maintenance definitions
-- ------------------------------------------------------------
create table if not exists public.pm_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default '',
  cadence text not null
    constraint pm_templates_cadence_check
    check (cadence in ('monthly', 'quarterly', 'semiannual', 'annual')),
  -- Month (1-12) the cadence cycle is anchored to; null means January.
  anchor_month integer
    constraint pm_templates_anchor_month_check
    check (anchor_month is null or (anchor_month between 1 and 12)),
  scope_type text not null default 'all'
    constraint pm_templates_scope_type_check
    check (scope_type in ('all', 'building', 'classification')),
  scope_values text[] not null default '{}',
  active boolean not null default true,
  created_by text not null default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

drop trigger if exists pm_templates_updated_at on public.pm_templates;
create trigger pm_templates_updated_at
  before update on public.pm_templates
  for each row execute function public.update_updated_at_column();

alter table public.pm_templates enable row level security;

-- ------------------------------------------------------------
-- pm_tasks — one row per (template, round, unit); generated nightly
-- ------------------------------------------------------------
create table if not exists public.pm_tasks (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.pm_templates(id) on delete cascade,
  round_key text not null,             -- "YYYY-MM" of the period start
  unit_number text not null,
  due_date date not null,
  status text not null default 'pending'
    constraint pm_tasks_status_check
    check (status in ('pending', 'done', 'skipped')),
  completed_by text not null default '',
  completed_at timestamptz,
  resman_work_order_id text,
  created_at timestamptz default now(),
  -- Generation idempotency key: re-runs INSERT ... ON CONFLICT DO NOTHING, so
  -- completed/skipped tasks are never clobbered.
  unique (template_id, round_key, unit_number)
);

create index if not exists pm_tasks_round_key_idx on public.pm_tasks (round_key);
create index if not exists pm_tasks_pending_status_idx on public.pm_tasks (status) where status = 'pending';

alter table public.pm_tasks enable row level security;
