-- Renewal offers: the manager app's renewal pipeline. Every expiring lease
-- moves through a tracked offer flow (needs offer → offer sent → response),
-- the same Emberly-owned action pattern as delinquency_actions — ResMan stays
-- the lease of record, Emberly owns the offer workflow. The lease reference
-- is soft: the sync's delete-missing pass may remove a lease, but the offer
-- history (and the lift metric it feeds) must survive it. term_months null +
-- is_month_to_month true is the MTM offer; the MTM premium is just the
-- proposed_rent. Brings a database matching the pre-renewals schema.sql up to
-- the new shape.

create table if not exists public.renewal_offers (
  id uuid primary key default gen_random_uuid(),
  resman_lease_id text not null,       -- soft ref (lease may be deleted by sync)
  resman_unit_id text not null default '',
  unit_number text not null default '',
  prior_rent numeric(12,2),            -- resident rent when the offer went out
  proposed_rent numeric(12,2) not null,
  term_months integer,                 -- null for month-to-month offers
  is_month_to_month boolean not null default false,
  status text not null default 'sent' check (status in ('sent','accepted','declined','withdrawn')),
  sent_at timestamptz default now(),
  responded_at timestamptz,            -- stamped when the offer resolves
  note text not null default '',
  created_by text not null default '', -- staff display name from token label
  created_by_admin_id text not null default '',
  created_at timestamptz default now(),
  deleted_at timestamptz
);

create index if not exists renewal_offers_lease_idx
  on public.renewal_offers (resman_lease_id, deleted_at);

-- Service-role only, like the other Emberly-owned tables: RLS on, no policies.
alter table public.renewal_offers enable row level security;
