-- ============================================================
-- Emberly Security — Supabase Schema
-- ============================================================

-- Enable UUID extension (already available in Supabase)
-- create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- Residents (synced from Resman stub)
-- ------------------------------------------------------------
create table residents (
  id uuid primary key default gen_random_uuid(),
  resman_ledger_id text unique not null,
  resman_login text not null,  -- Resman portal username (shared across all residents in a household)
  name text not null,
  unit_id text not null,
  access_allowed boolean not null default false,
  access_status text,
  last_resman_verified_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index residents_unit_id_idx on residents (unit_id);
create index residents_resman_login_idx on residents (resman_login);
create index residents_resman_ledger_id_idx on residents (resman_ledger_id);
create index residents_access_health_idx on residents (access_allowed, last_resman_verified_at desc);

-- Auto-update updated_at
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

/*
 * Change-detecting variant, for MIRROR tables whose sync re-upserts every row on
 * every pass (upsertMirror — that is what makes it idempotent). With the
 * unconditional function above, such a table's updated_at means "the scraper
 * last ran", not "this row changed", so nothing can ask what moved since it last
 * looked: a `updated_at > x` filter returns the whole table.
 *
 * Ignores updated_at (computed here) and synced_at (provenance — the sync stamps
 * it every pass on purpose, so max(synced_at) stays the "last scrape" signal
 * while updated_at answers "what actually changed").
 */
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

create trigger residents_updated_at
  before update on residents
  for each row execute function update_updated_at_column();

-- ------------------------------------------------------------
-- Guest passes
-- ------------------------------------------------------------
create table guest_passes (
  id uuid primary key default gen_random_uuid(),
  resident_id uuid references residents(id) on delete cascade not null,
  guest_name text not null,
  guest_email text not null,
  guest_phone text,
  guest_address text,
  share_token text unique not null, -- random token used for public browser share URLs
  expires_at timestamptz not null,  -- 24h from creation
  used_at timestamptz,
  status text not null default 'active' check (status in ('active', 'revoked', 'used')),
  email_delivery_status text not null default 'pending' check (email_delivery_status in ('pending', 'sent', 'failed')),
  email_provider_id text,
  email_sent_at timestamptz,
  email_last_error text,
  created_at timestamptz default now()
);

create index guest_passes_resident_id_idx on guest_passes (resident_id);
create index guest_passes_share_token_idx on guest_passes (share_token);
create index guest_passes_expires_at_idx on guest_passes (expires_at);
create index guest_passes_created_at_idx on guest_passes (created_at desc);
create index guest_passes_resident_created_at_idx on guest_passes (resident_id, created_at desc);

-- ------------------------------------------------------------
-- Entry logs
-- ------------------------------------------------------------
create table entry_logs (
  id uuid primary key default gen_random_uuid(),
  resident_id uuid references residents(id) on delete set null,
  guest_pass_id uuid references guest_passes(id) on delete set null,
  entry_type text not null check (entry_type in ('resident', 'guest')),
  tenant_name text not null,
  unit_address text not null,
  property_name text not null,
  entered_at timestamptz default now(),
  scanner_id text,
  notes text
);

create index entry_logs_resident_id_idx on entry_logs (resident_id);
create index entry_logs_entered_at_idx on entry_logs (entered_at desc);
create index entry_logs_property_name_idx on entry_logs (property_name);
create index entry_logs_entry_type_idx on entry_logs (entry_type);
create index entry_logs_scanner_entered_at_idx on entry_logs (scanner_id, entered_at desc);
-- `unit_address` is an exposed API filter and backs the per-unit "last entry"
-- lookup; composite so that lookup is one range read rather than a walk down
-- entry_logs_entered_at_idx until the unit turns up.
create index entry_logs_unit_address_entered_at_idx on entry_logs (unit_address, entered_at desc);

-- ------------------------------------------------------------
-- Entry log photos
-- ------------------------------------------------------------
create table entry_log_photos (
  id uuid primary key default gen_random_uuid(),
  entry_log_id uuid not null references entry_logs(id) on delete cascade,
  resident_id uuid references residents(id) on delete set null,
  guest_pass_id uuid references guest_passes(id) on delete set null,
  entry_type text not null check (entry_type in ('resident', 'guest')),
  scanner_id text,
  storage_path text not null,
  content_type text not null,
  byte_size integer not null check (byte_size >= 0),
  flagged_at timestamptz,
  retention_expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz default now()
);

create index entry_log_photos_entry_log_idx on entry_log_photos (entry_log_id, created_at desc);
create index entry_log_photos_resident_idx on entry_log_photos (resident_id, created_at desc);
create index entry_log_photos_guest_pass_idx on entry_log_photos (guest_pass_id, created_at desc);
create index entry_log_photos_scanner_idx on entry_log_photos (scanner_id, created_at desc);
create index entry_log_photos_retention_cleanup_idx on entry_log_photos (retention_expires_at)
  where flagged_at is null;

-- Private storage bucket for scan photos (service role only).
insert into storage.buckets (id, name, public)
values ('entry-log-photos', 'entry-log-photos', false)
on conflict (id) do update
set public = excluded.public;

-- ------------------------------------------------------------
-- Admin: residents suspended from creating guest passes
-- ------------------------------------------------------------
create table guest_pass_bans (
  id uuid primary key default gen_random_uuid(),
  resident_id uuid references residents(id) on delete cascade unique not null,
  reason text,
  banned_by text not null,
  banned_at timestamptz default now()
);

create index guest_pass_bans_resident_id_idx on guest_pass_bans (resident_id);

-- ------------------------------------------------------------
-- Admin: units suspended from guest visits (no enrollment needed)
-- ------------------------------------------------------------
-- Keys the suspension to the ResMan unit so households that never registered
-- a resident login can still have guest visits disabled. unit_number is the
-- bridge to the first-party side (residents.unit_id / entry_logs), which is
-- where creation and verify-pass enforce it.
-- Expiry follows the unit-tag vocabulary (see lib/unit-expiry.ts), so a
-- suspension can lift at move-out the way the tag that prompted it does,
-- instead of outliving the household it was set against.
create table guest_pass_unit_bans (
  resman_unit_id text primary key,
  unit_number text not null,
  reason text,
  banned_by text not null,
  banned_at timestamptz not null default now(),
  expiry_kind text not null default 'never'
    check (expiry_kind in ('never', 'date', 'duration', 'move_out', 'status_change')),
  expires_at timestamptz,
  bound_lease_id text,
  status_trigger text
);

create index guest_pass_unit_bans_unit_number_idx on guest_pass_unit_bans (unit_number);
create index guest_pass_unit_bans_expires_at_idx
  on guest_pass_unit_bans (expires_at)
  where expires_at is not null;

-- ------------------------------------------------------------
-- Row-Level Security (RLS)
-- ------------------------------------------------------------
-- Enable RLS on all tables; service role bypasses RLS
alter table residents enable row level security;
alter table guest_passes enable row level security;
alter table entry_logs enable row level security;
alter table entry_log_photos enable row level security;
alter table guest_pass_bans enable row level security;
alter table guest_pass_unit_bans enable row level security;

-- Allow service role full access (used by API routes)
-- Public/anon access is denied by default with RLS enabled and no policies

-- ------------------------------------------------------------
-- Admin: scanner device registry
-- ------------------------------------------------------------
create table scanner_devices (
  id uuid primary key default gen_random_uuid(),
  scanner_id text unique not null,
  name text not null,
  location text,
  enabled boolean not null default true,
  secret_hash text,
  secret_rotated_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index scanner_devices_scanner_id_idx on scanner_devices (scanner_id);
create index scanner_devices_last_seen_at_idx on scanner_devices (last_seen_at desc);
create index scanner_devices_secret_rotated_at_idx on scanner_devices (secret_rotated_at desc);

-- scanner_devices is the SOLE source of scanner keys (no env-configured keys).
-- secret_hash is a deterministic HMAC, so a presented key self-identifies: the
-- server hashes it and looks the device up here. UNIQUE keeps that lookup
-- unambiguous (no two devices can share a secret) and fast.
create unique index scanner_devices_secret_hash_key
  on scanner_devices (secret_hash)
  where secret_hash is not null;

create trigger scanner_devices_updated_at
  before update on scanner_devices
  for each row execute function update_updated_at_column();

alter table scanner_devices enable row level security;

-- ------------------------------------------------------------
-- Admin users and audit logs
-- ------------------------------------------------------------
-- Admin users are authenticated against the ResMan staff portal; a row is created
-- on first successful login. The retired shared ADMIN_LOGIN_KEY model left a
-- key_hash column behind; it was dropped on 2026-08-02.
create table admin_users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  display_name text,
  role text not null check (role in ('super_admin', 'property_manager', 'security_manager', 'viewer')),
  resman_username text,
  resman_person_id text,
  last_login_at timestamptz,
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index admin_users_active_idx on admin_users (active);
create index admin_users_role_idx on admin_users (role);
-- Keyed on lower(): ResMan matches usernames case-insensitively, so `rdeojeda`
-- and `Rdeojeda` are one person. Indexing the raw string let the second
-- spelling insert a second row with its own id and its own ROLE, making
-- whichever spelling someone typed decide what they could see.
create unique index admin_users_resman_username_idx
  on admin_users (lower(resman_username))
  where resman_username is not null;
create index admin_users_resman_person_id_idx
  on admin_users (resman_person_id)
  where resman_person_id is not null;

create trigger admin_users_updated_at
  before update on admin_users
  for each row execute function update_updated_at_column();

alter table admin_users enable row level security;

-- One table for every bearer token: per-user MCP tokens (/api/mcp) and per-user
-- API tokens (/api/resman). Hash-only — the plaintext is shown once at creation
-- and never stored. (Scanner keys are separate: see scanner_devices.)
create table access_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text unique not null,            -- SHA-256 hex of the bearer token
  token_prefix text not null default '',      -- first chars for identification (not secret)
  kind text not null default 'mcp' check (kind in ('mcp', 'api_resman')),
  subject_type text not null default 'admin_user' check (subject_type in ('admin_user', 'scanner')),
  subject_id text not null default '',        -- admin_users.id or scanner_id
  label text not null default '',             -- display name (staff / scanner)
  role text not null default 'staff',
  scopes text[] not null default '{}',        -- resource-name allowlist; empty = all
  active boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index access_tokens_token_hash_idx on access_tokens (token_hash);
create index access_tokens_subject_idx on access_tokens (subject_type, subject_id);

alter table access_tokens enable row level security;

-- Per-call attribution for access_tokens (MCP tool calls / API routes).
create table access_token_audit_log (
  id uuid primary key default gen_random_uuid(),
  token_id uuid references access_tokens(id) on delete set null,
  subject_type text not null default '',
  subject_id text not null default '',
  label text not null default '',
  kind text not null default '',
  tool text not null default '',              -- MCP tool or API route
  resource text not null default '',
  arguments jsonb,
  ok boolean not null default true,
  error text not null default '',
  created_at timestamptz not null default now()
);

create index access_token_audit_created_at_idx on access_token_audit_log (created_at desc);

alter table access_token_audit_log enable row level security;

create table admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_user_id text not null,
  admin_role text not null,
  admin_display_name text,
  action text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index admin_audit_logs_created_at_idx on admin_audit_logs (created_at desc);
create index admin_audit_logs_actor_idx on admin_audit_logs (admin_user_id, created_at desc);
create index admin_audit_logs_target_idx on admin_audit_logs (target_type, target_id, created_at desc);

alter table admin_audit_logs enable row level security;

-- ------------------------------------------------------------
-- Admin: exception alerts
-- ------------------------------------------------------------
create table admin_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null check (
    alert_type in (
      'resident_access_stale',
      'resident_access_denied',
      'scanner_offline',
      'guest_pass_denied',
      'security_scan_denied'
    )
  ),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  subject_type text not null check (subject_type in ('resident', 'guest_pass', 'scanner', 'system')),
  subject_id text not null,
  title text not null,
  detail text,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index admin_alerts_status_created_at_idx on admin_alerts (status, created_at desc);
create index admin_alerts_subject_idx on admin_alerts (subject_type, subject_id);
create unique index admin_alerts_open_unique_idx
  on admin_alerts (alert_type, subject_type, subject_id)
  where status = 'open';

create trigger admin_alerts_updated_at
  before update on admin_alerts
  for each row execute function update_updated_at_column();

alter table admin_alerts enable row level security;

-- ------------------------------------------------------------
-- Durable rate limiting
-- ------------------------------------------------------------
create table rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  count integer not null default 0,
  expires_at timestamptz not null,
  updated_at timestamptz default now()
);

create index rate_limits_expires_at_idx on rate_limits (expires_at);

alter table rate_limits enable row level security;

-- SECURITY DEFINER runs with the OWNER's rights, so an unqualified name inside
-- the body resolves through the CALLER's search_path — a caller who can create
-- a schema could shadow `rate_limits` and have this function write somewhere
-- else entirely, as the owner. Pinning search_path closes that; it is not
-- optional decoration on a definer function.
create or replace function check_rate_limit(
  p_bucket text,
  p_max_attempts integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_row rate_limits%rowtype;
begin
  insert into rate_limits (bucket, window_start, count, expires_at, updated_at)
  values (p_bucket, v_now, 1, v_now + make_interval(secs => p_window_seconds), v_now)
  on conflict (bucket) do update
    set window_start = case
          when rate_limits.expires_at <= v_now then v_now
          else rate_limits.window_start
        end,
        count = case
          when rate_limits.expires_at <= v_now then 1
          else rate_limits.count + 1
        end,
        expires_at = case
          when rate_limits.expires_at <= v_now then v_now + make_interval(secs => p_window_seconds)
          else rate_limits.expires_at
        end,
        updated_at = v_now
  returning * into v_row;

  return v_row.count <= p_max_attempts;
end;
$$;

-- ------------------------------------------------------------
-- Resident device sessions
-- ------------------------------------------------------------
create table resident_devices (
  id uuid primary key default gen_random_uuid(),
  resident_id uuid references residents(id) on delete cascade not null,
  token_hash text unique not null,
  user_agent text,
  active boolean not null default true,
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index resident_devices_resident_id_idx on resident_devices (resident_id);
create index resident_devices_last_seen_at_idx on resident_devices (last_seen_at desc);
create index resident_devices_expires_at_idx on resident_devices (expires_at);
create index resident_devices_active_expiry_idx on resident_devices (active, expires_at);

create trigger resident_devices_updated_at
  before update on resident_devices
  for each row execute function update_updated_at_column();

alter table resident_devices enable row level security;

-- map_sync_access_requests and map_sync_keys were dropped on 2026-08-02
-- (deltas/2026-08-02-drop-map-sync-subsystem.sql). They backed a device
-- enrolment handshake for an external sync client that was never built; no
-- client in this repo could create the first row, and both held zero rows.
-- Annotations are written through /api/admin/map-annotations, which accepts a
-- maintenance staff token or a security scanner key.

create table if not exists public.map_annotations (
  id uuid primary key default gen_random_uuid(),
  resman_account_id text not null,
  property_id text not null,
  feature_key text not null default 'property_map.annotations',
  title text not null,
  notes text not null default '',
  normalized_x double precision not null check (normalized_x >= 0 and normalized_x <= 1),
  normalized_y double precision not null check (normalized_y >= 0 and normalized_y <= 1),
  color_hex text not null,
  -- Two overlays share the canvas: 'staff' (external XCMS client + admin) and
  -- 'security' (guard iPads + admin). Origin records which door a row came
  -- through; admin/scanner writers have no sync key, hence the nullable FK.
  layer text not null default 'staff'
    constraint map_annotations_layer_check check (layer in ('staff', 'security', 'utility')),
  -- Utility overlay (see deltas/2026-07-21-utility-layer.sql): a row is a
  -- plain pin, a utility pin, or a drawn utility polyline. Utility kinds live
  -- on the shared 'utility' layer, visible to both staff and security surfaces.
  kind text not null default 'pin'
    constraint map_annotations_kind_check check (kind in ('pin', 'utility_pin', 'utility_line')),
  -- 'internet' joined the set in deltas/2026-07-25-utility-internet-layer.sql.
  -- 'electrical' deliberately keeps its name rather than becoming 'power': it is
  -- a persisted value on existing runs, and renaming buys only a shorter word.
  utility_type text
    constraint map_annotations_utility_type_check
    check (utility_type is null or utility_type in ('water', 'sewer', 'gas', 'electrical', 'internet', 'other')),
  -- For kind='utility_line': ordered array of {x, y} objects, each normalized
  -- 0..1 against the map image. Null for pin kinds.
  points jsonb,
  -- Per-run presentation (see deltas/2026-07-21-utility-run-styles.sql),
  -- only for kind='utility_line'. Null means "type default" so pre-existing
  -- rows render exactly as before: sewer dashed, gas dotted, others solid,
  -- medium weight, no arrows. The label rides `title`; direction is the order
  -- of `points`.
  line_style text
    constraint map_annotations_line_style_check
    check (line_style is null or line_style in ('solid', 'dashed', 'dotted')),
  line_weight text
    constraint map_annotations_line_weight_check
    check (line_weight is null or line_weight in ('thin', 'medium', 'thick')),
  flow_arrows boolean,
  origin text not null default 'sync'
    constraint map_annotations_origin_check check (origin in ('sync', 'admin', 'scanner')),
  created_by_display_name text,
  created_at timestamptz default now(),
  updated_by_display_name text,
  updated_at timestamptz default now(),
  deleted_by_display_name text,
  deleted_at timestamptz,
  version integer not null default 1 check (version > 0),
  constraint map_annotations_feature_key_check check (feature_key = 'property_map.annotations')
);

create unique index if not exists map_annotations_scope_reference_idx
  on public.map_annotations (id, resman_account_id, property_id, feature_key);

create index if not exists map_annotations_property_updated_idx
  on public.map_annotations (resman_account_id, property_id, updated_at desc);

create index if not exists map_annotations_scope_layer_idx
  on public.map_annotations (resman_account_id, property_id, layer, updated_at desc);

create index if not exists map_annotations_deleted_idx
  on public.map_annotations (deleted_at);

drop trigger if exists map_annotations_updated_at on public.map_annotations;
create trigger map_annotations_updated_at
  before update on public.map_annotations
  for each row execute function public.update_updated_at_column();

alter table public.map_annotations enable row level security;

create table if not exists public.map_annotation_photos (
  id uuid primary key default gen_random_uuid(),
  annotation_id uuid not null,
  resman_account_id text not null,
  property_id text not null,
  feature_key text not null default 'property_map.annotations',
  storage_path text not null,
  content_type text not null,
  byte_size integer not null check (byte_size >= 0),
  created_by text not null default '',
  created_at timestamptz default now(),
  deleted_at timestamptz,
  constraint map_annotation_photos_feature_key_check check (feature_key = 'property_map.annotations'),
  constraint map_annotation_photos_annotation_scope_fkey
    foreign key (annotation_id, resman_account_id, property_id, feature_key)
    references public.map_annotations (id, resman_account_id, property_id, feature_key)
    on delete cascade
);

create index if not exists map_annotation_photos_annotation_idx
  on public.map_annotation_photos (annotation_id, deleted_at);

alter table public.map_annotation_photos enable row level security;

create table if not exists public.map_annotation_audit_logs (
  id uuid primary key default gen_random_uuid(),
  resman_account_id text not null,
  property_id text not null,
  feature_key text not null,
  action text not null check (action in (
    'access.request',
    'access.approve',
    'access.reject',
    'access.claim',
    'access.revoke',
    'annotation.create',
    'annotation.update',
    'annotation.delete'
  )),
  annotation_id uuid,
  actor_display_name text,
  admin_user_id text,
  admin_display_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  constraint map_annotation_audit_logs_annotation_scope_fkey
    foreign key (annotation_id, resman_account_id, property_id, feature_key)
    references public.map_annotations (id, resman_account_id, property_id, feature_key)
);

create index if not exists map_annotation_audit_logs_property_idx
  on public.map_annotation_audit_logs (resman_account_id, property_id, created_at desc);

create index if not exists map_annotation_audit_logs_annotation_idx
  on public.map_annotation_audit_logs (annotation_id, created_at desc);

alter table public.map_annotation_audit_logs enable row level security;

-- ============================================================
-- ResMan (resman_*) + MLGW (mlgw_*) sync-mirror schema
-- Ported from the Swift "Kraken" package (docs/resman-port-design.md §2).
-- Natural source-id text primary keys; enums as text + check constraints;
-- RLS enabled with no policies (service role only); updated_at via the
-- existing public.update_updated_at_column() trigger. Migration:
-- lib/supabase/migrations/20260711_resman_mlgw_sync.sql
-- ============================================================

-- resman_companies was dropped on 2026-08-02 (deltas/2026-08-02-drop-resman-companies.sql).
-- It held the subdomain / account / company config for a multi-tenant install.
-- This deployment serves one ResMan account, and the sync derives those values
-- from ENV (supabase/sync/src/resman/config.ts) — the table was never read.

-- ------------------------------------------------------------
-- resman_properties (from Property)
-- ------------------------------------------------------------
create table if not exists public.resman_properties (
  resman_property_id text primary key,
  resman_account_id text not null default '1659',
  name text not null default '',
  custom_name text not null default '',      -- user-set; sync must never overwrite
  abbreviation text not null default '',
  phone text not null default '',
  email text not null default '',
  website text not null default '',
  logo_url text not null default '',
  management_company text not null default '',
  property_type text not null default '',
  time_zone text not null default '',
  regional_manager text not null default '',
  property_manager text not null default '',
  leasing_agent text not null default '',
  resident_portal_url text not null default '',
  address text not null default '',
  city text not null default '',
  state text not null default '',
  postal_code text not null default '',
  unit_count integer not null default 0,
  last_sync_date timestamptz,
  synced_at timestamptz default now(),
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_properties_resman_account_id_idx on public.resman_properties (resman_account_id);
create index if not exists resman_properties_name_idx on public.resman_properties (name);

drop trigger if exists resman_properties_updated_at on public.resman_properties;
create trigger resman_properties_updated_at
  before update on public.resman_properties
  for each row execute function public.update_updated_at_column();

alter table public.resman_properties enable row level security;

-- ------------------------------------------------------------
-- resman_buildings (from Building)
-- ------------------------------------------------------------
create table if not exists public.resman_buildings (
  resman_building_id text primary key,
  resman_property_id text not null references public.resman_properties(resman_property_id) on delete cascade,
  name text not null default '',
  synced_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_buildings_resman_property_id_idx on public.resman_buildings (resman_property_id);

drop trigger if exists resman_buildings_updated_at on public.resman_buildings;
create trigger resman_buildings_updated_at
  before update on public.resman_buildings
  for each row execute function public.update_updated_at_column();

alter table public.resman_buildings enable row level security;

-- ------------------------------------------------------------
-- resman_floorplans (from Floorplan; ResMan UnitTypes)
-- ------------------------------------------------------------
create table if not exists public.resman_floorplans (
  resman_floorplan_id text primary key,
  resman_property_id text references public.resman_properties(resman_property_id) on delete cascade,
  name text not null default '',
  description text not null default '',
  square_feet integer,
  market_rent numeric(12,2),
  synced_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_floorplans_resman_property_id_idx on public.resman_floorplans (resman_property_id);

drop trigger if exists resman_floorplans_updated_at on public.resman_floorplans;
create trigger resman_floorplans_updated_at
  before update on public.resman_floorplans
  for each row execute function public.update_updated_at_column();

alter table public.resman_floorplans enable row level security;

-- ------------------------------------------------------------
-- resman_units (from PropertyUnit)
-- ------------------------------------------------------------
create table if not exists public.resman_units (
  resman_unit_id text primary key,
  resman_property_id text not null references public.resman_properties(resman_property_id) on delete cascade,
  resman_building_id text references public.resman_buildings(resman_building_id) on delete set null,
  resman_floorplan_id text references public.resman_floorplans(resman_floorplan_id) on delete set null,  -- from the unit PAGE (sync:unit-details), not the roster report
  number text not null default '',
  current_lease_id text,               -- denormalized, nullable (no FK)
  pending_lease_id text,               -- denormalized, nullable
  availability text not null default '',
  lease_status text check (lease_status is null or lease_status in ('Current','Under Eviction','Notice to Vacate','Month to Month','Pending','Pending Renewal','Renewed','Cancelled')),  -- the CURRENT lease; a vacant unit has none, so Evicted/Former never appear
  occupancy_status text check (occupancy_status is null or occupancy_status in ('Occupied','Vacant','Notice')),
  classification text not null default '',
  notes text not null default '',
  occupied boolean,
  market_rent numeric(12,2),
  lease_rent numeric(12,2),
  deposit_required numeric(12,2),
  deposit_held numeric(12,2),
  balance numeric(12,2),
  bedrooms integer,
  bathrooms numeric(3,1),
  pets_permitted boolean,                -- from the unit PAGE (sync:unit-details)
  affordable_unit boolean,               -- from the unit PAGE (sync:unit-details)
  holding_unit boolean,
  excluded_from_occupancy boolean,
  available_for_online_marketing boolean,
  street text not null default '',
  city text not null default '',
  state text not null default '',
  postal_code text not null default '',
  country text not null default '',      -- from the unit PAGE (sync:unit-details); the unit-info report has no country
  lease_start_date date,
  lease_end_date date,
  move_in_date date,
  move_out_date date,
  -- Available Units enrichment (Reports/GetAvailableUnitsReport)
  lease_term text,
  old_lease_id text,
  date_available date,
  leasing_agent text,
  -- Unit Info enrichment (Reports/GetUnitInfoReport)
  floor text,
  hearing_accessible boolean,
  mobility_accessible boolean,
  visual_accessible boolean,
  pending_move_in_date date,
  pending_lease_start_date date,
  pending_lease_end_date date,
  max_occupancy integer,
  -- Delinquency with Aging enrichment (Reports/GetDelinquencywithAgingReport); balance above
  current_month_balance numeric(12,2),
  last_month_balance numeric(12,2),
  period_balance numeric(12,2),
  previous_balance numeric(12,2),
  times_late integer,
  delinquency_reason text,
  tenant_names text[] not null default '{}',
  source_url text not null default '',
  scraped_at timestamptz,              -- detail-scrape freshness (drives incremental sync)
  synced_at timestamptz default now(),
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_units_resman_property_id_idx on public.resman_units (resman_property_id);
create index if not exists resman_units_resman_building_id_idx on public.resman_units (resman_building_id);
create index if not exists resman_units_number_resman_building_id_idx on public.resman_units (number, resman_building_id);
create index if not exists resman_units_current_lease_id_idx on public.resman_units (current_lease_id);
create index if not exists resman_units_resman_property_id_scraped_at_idx on public.resman_units (resman_property_id, scraped_at);
create index if not exists resman_units_property_updated_at_idx
  on public.resman_units (resman_property_id, updated_at desc);

-- Change-detecting, NOT the shared unconditional trigger: this is a mirror
-- table, re-upserted in full every sync pass, and the maintenance app reads it
-- as a delta (?updated_since=). synced_at remains the "last scrape" signal.
drop trigger if exists resman_units_updated_at on public.resman_units;
create trigger resman_units_updated_at
  before update on public.resman_units
  for each row execute function public.touch_updated_at_on_change();

alter table public.resman_units enable row level security;

-- ------------------------------------------------------------
-- resman_leases (from Lease)
-- ------------------------------------------------------------
create table if not exists public.resman_leases (
  resman_lease_id text primary key,
  unit_lease_group_id text not null default '',   -- <=> residents.resman_ledger_id
  resman_property_id text references public.resman_properties(resman_property_id) on delete cascade,
  resman_unit_id text references public.resman_units(resman_unit_id) on delete set null,
  unit_number text not null default '',
  status text not null default '',                -- raw ResMan status string
  approval_status text not null default '',
  approved_date date,                             -- from the Activity Log; ResMan has no approval-date field
  approved_by text not null default '',           -- the staff member the Activity Log credits
  original_start_date date,                       -- the first start date the lease had, before any change
  start_date_changes integer not null default 0,  -- how many times the desired move-in has moved
  lease_sent_date date,                           -- signature package sent (Activity Log)
  lease_voided_date date,                         -- signature package voided (Activity Log)
  deposit_amount numeric(12,2),                   -- security deposit added (Activity Log); null = none taken
  deposit_logged_date date,                       -- the day the log recorded that deposit
  application_date date,
  signed_date date,
  start_date date,
  end_date date,
  move_in_date date,
  move_out_date date,
  leasing_agent text not null default '',
  renewal_date date,
  notice_given_date date,
  market_rent numeric(12,2),
  resident_rent numeric(12,2),
  hap_rent numeric(12,2),
  monthly_charge numeric(12,2),
  balance numeric(12,2),
  collection_balance numeric(12,2),
  reason_for_leaving text not null default '',
  is_current_lease boolean not null default false,
  is_most_recent_lease boolean not null default false,
  synced_at timestamptz default now(),
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_leases_resman_unit_id_idx on public.resman_leases (resman_unit_id);
create index if not exists resman_leases_resman_property_id_idx on public.resman_leases (resman_property_id);
create index if not exists resman_leases_unit_lease_group_id_idx on public.resman_leases (unit_lease_group_id);
create index if not exists resman_leases_resman_unit_id_is_current_lease_idx on public.resman_leases (resman_unit_id, is_current_lease);

drop trigger if exists resman_leases_updated_at on public.resman_leases;
create trigger resman_leases_updated_at
  before update on public.resman_leases
  for each row execute function public.update_updated_at_column();

alter table public.resman_leases enable row level security;

-- ------------------------------------------------------------
-- resman_residents (from Resident / LeaseResident) — occupant records.
-- Distinct from the existing public.residents table (portal logins).
-- ------------------------------------------------------------
create table if not exists public.resman_residents (
  resman_person_lease_id text primary key,
  resman_person_id text not null default '',
  resman_lease_id text not null references public.resman_leases(resman_lease_id) on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  email text not null default '',
  phone_numbers text[] not null default '{}',
  gender text not null default '',
  birthdate date,                                 -- PII
  household_status text not null default '',
  drivers_license text not null default '',       -- PII
  drivers_license_state text not null default '', -- PII
  language text not null default '',
  identification text not null default '',
  is_primary boolean not null default false,
  synced_at timestamptz default now(),
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_residents_resman_lease_id_idx on public.resman_residents (resman_lease_id);
create index if not exists resman_residents_resman_lease_id_is_primary_idx on public.resman_residents (resman_lease_id, is_primary);
create index if not exists resman_residents_resman_person_id_idx on public.resman_residents (resman_person_id);

drop trigger if exists resman_residents_updated_at on public.resman_residents;
create trigger resman_residents_updated_at
  before update on public.resman_residents
  for each row execute function public.update_updated_at_column();

alter table public.resman_residents enable row level security;

-- ------------------------------------------------------------
-- resman_lease_vehicles (from LeaseVehicle)
-- ------------------------------------------------------------
create table if not exists public.resman_lease_vehicles (
  resman_vehicle_id text primary key,
  resman_person_lease_id text not null references public.resman_residents(resman_person_lease_id) on delete cascade,
  make text not null default '',
  model text not null default '',
  year text not null default '',
  color text not null default '',
  license_plate text not null default '',
  license_plate_state text not null default '',
  parking_spot text not null default '',          -- always empty: ResMan has no parking-space field; see permit_number
  permit_number text not null default '',         -- parking decal number ("Permit number" on the Vehicles tab)
  notes text not null default '',                 -- free text on the Vehicles tab, usually decal history
  synced_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_lease_vehicles_resman_person_lease_id_idx on public.resman_lease_vehicles (resman_person_lease_id);

drop trigger if exists resman_lease_vehicles_updated_at on public.resman_lease_vehicles;
create trigger resman_lease_vehicles_updated_at
  before update on public.resman_lease_vehicles
  for each row execute function public.update_updated_at_column();

alter table public.resman_lease_vehicles enable row level security;

-- ------------------------------------------------------------
-- resman_lease_employment (from LeaseEmployment)
-- ------------------------------------------------------------
create table if not exists public.resman_lease_employment (
  resman_employment_id text primary key,
  resman_person_lease_id text not null references public.resman_residents(resman_person_lease_id) on delete cascade,
  employer_name text not null default '',
  position text not null default '',
  phone text not null default '',
  other_income_source text not null default '',   -- other-income records only (Industry cell reads "Other Income"); empty on a job
  monthly_income numeric(12,2),                   -- MONTHLY, normalized from the tab's pay period
  other_income numeric(12,2),                     -- MONTHLY, normalized from the tab's pay period
  start_date date,
  synced_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_lease_employment_resman_person_lease_id_idx on public.resman_lease_employment (resman_person_lease_id);

drop trigger if exists resman_lease_employment_updated_at on public.resman_lease_employment;
create trigger resman_lease_employment_updated_at
  before update on public.resman_lease_employment
  for each row execute function public.update_updated_at_column();

alter table public.resman_lease_employment enable row level security;

-- ------------------------------------------------------------
-- resman_lease_insurance (from LeaseInsurance)
-- ------------------------------------------------------------
create table if not exists public.resman_lease_insurance (
  resman_insurance_id text primary key,
  resman_person_lease_id text not null references public.resman_residents(resman_person_lease_id) on delete cascade,
  provider text not null default '',
  policy_number text not null default '',
  policy_type text not null default '',
  status text not null default '',
  start_date date,                                -- always empty: the Insurance tab records only an expiration date
  end_date date,
  coverage_amount numeric(12,2),
  synced_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_lease_insurance_resman_person_lease_id_idx on public.resman_lease_insurance (resman_person_lease_id);

drop trigger if exists resman_lease_insurance_updated_at on public.resman_lease_insurance;
create trigger resman_lease_insurance_updated_at
  before update on public.resman_lease_insurance
  for each row execute function public.update_updated_at_column();

alter table public.resman_lease_insurance enable row level security;

-- ------------------------------------------------------------
-- resman_lease_addresses (from LeaseAddress)
-- ------------------------------------------------------------
create table if not exists public.resman_lease_addresses (
  resman_address_id text primary key,
  resman_person_lease_id text not null references public.resman_residents(resman_person_lease_id) on delete cascade,
  address_type text not null default '',
  street text not null default '',
  city text not null default '',
  state text not null default '',
  postal_code text not null default '',
  country text not null default '',
  start_date date,                                -- always empty: the Addresses tab records no dates
  end_date date,                                  -- always empty: the Addresses tab records no dates
  synced_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_lease_addresses_resman_person_lease_id_idx on public.resman_lease_addresses (resman_person_lease_id);

drop trigger if exists resman_lease_addresses_updated_at on public.resman_lease_addresses;
create trigger resman_lease_addresses_updated_at
  before update on public.resman_lease_addresses
  for each row execute function public.update_updated_at_column();

alter table public.resman_lease_addresses enable row level security;

-- ------------------------------------------------------------
-- resman_lease_alternate_contacts (from LeaseAlternateContact)
-- ------------------------------------------------------------
create table if not exists public.resman_lease_alternate_contacts (
  resman_contact_id text primary key,
  resman_person_lease_id text not null references public.resman_residents(resman_person_lease_id) on delete cascade,
  name text not null default '',
  relationship text not null default '',
  phone text not null default '',
  email text not null default '',
  is_emergency_contact boolean not null default false,
  synced_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_lease_alternate_contacts_resman_person_lease_id_idx on public.resman_lease_alternate_contacts (resman_person_lease_id);

drop trigger if exists resman_lease_alternate_contacts_updated_at on public.resman_lease_alternate_contacts;
create trigger resman_lease_alternate_contacts_updated_at
  before update on public.resman_lease_alternate_contacts
  for each row execute function public.update_updated_at_column();

alter table public.resman_lease_alternate_contacts enable row level security;

-- ------------------------------------------------------------
-- resman_transactions (from Transaction; ledger)
-- ------------------------------------------------------------
create table if not exists public.resman_transactions (
  resman_ledger_entry_id text primary key,
  resman_property_id text not null default '',    -- soft
  resman_unit_id text not null default '',        -- soft
  resman_lease_id text references public.resman_leases(resman_lease_id) on delete cascade,
  transaction_id text not null default '',        -- ResMan real UUID
  transaction_type text not null default '',
  date date,
  reference text not null default '',
  batch text not null default '',
  batch_id text not null default '',
  category text not null default '',
  ledger_description text not null default '',
  notes text not null default '',
  charges numeric(12,2),
  credits numeric(12,2),
  balance numeric(12,2),
  -- Intra-day ordering within a lease's ledger (the sync numbers rows as
  -- scraped, so same-date entries keep their running-balance order).
  ledger_sequence integer,
  synced_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_transactions_resman_lease_id_idx on public.resman_transactions (resman_lease_id);
create index if not exists resman_transactions_resman_property_id_resman_unit_id_idx on public.resman_transactions (resman_property_id, resman_unit_id);
create index if not exists resman_transactions_date_idx on public.resman_transactions (date);

drop trigger if exists resman_transactions_updated_at on public.resman_transactions;
create trigger resman_transactions_updated_at
  before update on public.resman_transactions
  for each row execute function public.update_updated_at_column();

alter table public.resman_transactions enable row level security;

-- ------------------------------------------------------------
-- resman_work_orders (from WorkOrder)
-- ------------------------------------------------------------
create table if not exists public.resman_work_orders (
  resman_work_order_id text primary key,
  number text not null default '',
  resman_unit_id text references public.resman_units(resman_unit_id) on delete set null,
  unit_lease_group_id text not null default '',   -- always empty: the work-order report carries no lease link
  resman_lease_id text not null default '',       -- always empty: the work-order report carries no lease link
  unit_number text not null default '',
  resman_property_id text references public.resman_properties(resman_property_id) on delete cascade,
  status text not null default 'Not Started' check (status in ('Not Started','Scheduled','In Progress','Completed','Closed','Canceled')),
  priority text not null default 'Normal' check (priority in ('Emergency','High','Normal','Low')),
  category text not null default '',
  title text not null default '',
  notes text not null default '',
  completion_notes text not null default '',
  technician text not null default '',
  date_reported date,
  date_scheduled date,
  date_completed date,
  is_make_ready boolean not null default false,
  callback_requested boolean not null default false,
  callback_completed boolean not null default false,
  tags text[] not null default '{}',              -- derived (WorkOrderTagging)
  is_duplicate boolean not null default false,    -- derived
  callback_status text not null default 'none' check (callback_status in ('none','possible','confirmed','dismissed')),
  callback_matched_work_order_id text not null default '',
  callback_engine_version text not null default '',
  callback_source text not null default '',
  callback_detected_at timestamptz,
  synced_at timestamptz default now(),
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists resman_work_orders_resman_unit_id_idx on public.resman_work_orders (resman_unit_id);
create index if not exists resman_work_orders_number_idx on public.resman_work_orders (number);
create index if not exists resman_work_orders_resman_property_id_idx on public.resman_work_orders (resman_property_id);
create index if not exists resman_work_orders_status_idx on public.resman_work_orders (status);
create index if not exists resman_work_orders_callback_status_idx on public.resman_work_orders (callback_status)
  where callback_status in ('possible','confirmed');

-- Supports the maintenance app's delta read (?updated_since=), which is
-- property-scoped.
create index if not exists resman_work_orders_property_updated_at_idx
  on public.resman_work_orders (resman_property_id, updated_at desc);

-- Change-detecting, NOT the shared unconditional trigger: this is a mirror
-- table, re-upserted in full every sync pass.
drop trigger if exists resman_work_orders_updated_at on public.resman_work_orders;
create trigger resman_work_orders_updated_at
  before update on public.resman_work_orders
  for each row execute function public.touch_updated_at_on_change();

alter table public.resman_work_orders enable row level security;

-- ------------------------------------------------------------
-- work_order_translations — server-side translation cache for work-order prose
-- ------------------------------------------------------------
-- The sync worker translates title/notes/completion_notes via Langbly and
-- stores the result keyed by a content hash of the SOURCE text
-- (packages/core textHash) plus the target language. The maintenance app reads
-- this and merges it into its on-device cache under the identical
-- `${lang}:${hash}` key, so a phone never re-translates prose the server
-- already paid to translate. Content-addressed: when a work order's text
-- changes its hash changes, a new row is written, and the stale row is reaped
-- once no live work order hashes to it.
create table if not exists work_order_translations (
  source_hash      text        not null,
  target_lang      text        not null check (target_lang in ('en', 'es')),
  source_lang      text        not null,
  translated_text  text        not null,
  char_count       integer     not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (source_hash, target_lang)
);

-- The device pulls "everything for my language, changed since my last sync".
create index if not exists work_order_translations_lang_updated_idx
  on work_order_translations (target_lang, updated_at desc);

-- Server-authoritative, like the resman_* mirrors: RLS on with no policy, so
-- only the service role reads or writes it.
alter table work_order_translations enable row level security;

-- ------------------------------------------------------------
-- work_order_photos — completion photos attached by maintenance techs
-- ------------------------------------------------------------
-- Technicians attach before/after photos when closing a work order in the
-- maintenance app. ResMan write-back is deferred (the close route is a stub),
-- so bytes live in the private `work-order-photos` Storage bucket and these
-- rows carry the pointer + author; the photos ride into ResMan when the
-- deferred write path is built. The FK cascades because the sync's
-- property-scoped delete-missing pass removes work orders that leave the
-- ResMan report.
create table if not exists public.work_order_photos (
  id uuid primary key default gen_random_uuid(),
  resman_work_order_id text not null
    references public.resman_work_orders(resman_work_order_id) on delete cascade,
  phase text not null default 'completion' check (phase in ('before','after','completion')),
  storage_path text not null,
  content_type text not null,
  byte_size integer not null check (byte_size >= 0 and byte_size <= 10485760),
  created_by text not null default '',          -- staff display name
  created_by_admin_id text not null default '',
  created_at timestamptz default now(),
  deleted_at timestamptz
);

create index if not exists work_order_photos_work_order_idx
  on public.work_order_photos (resman_work_order_id, deleted_at);

alter table public.work_order_photos enable row level security;

-- Private storage bucket for work-order completion photos (service role only).
-- Same pattern as entry-log-photos.
insert into storage.buckets (id, name, public)
values ('work-order-photos', 'work-order-photos', false)
on conflict (id) do update
set public = excluded.public;

-- ------------------------------------------------------------
-- pm_templates — admin-defined recurring maintenance definitions
-- ------------------------------------------------------------
-- Emberly-owned preventive maintenance (PM). Admins define templates; the sync
-- worker expands active templates into per-unit task "rounds" nightly and
-- idempotently (pm_tasks). ResMan is never written.
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

-- ------------------------------------------------------------
-- delinquency_actions — collections timeline for the manager app
-- ------------------------------------------------------------
-- Emberly-owned write surface: property managers record collection touchpoints
-- (calls, notices served, promises to pay, FED filings, write-offs, …) against
-- a lease from the manager app. The lease reference is soft — the sync's
-- delete-missing pass may remove a lease, but the action history must survive.
create table if not exists public.delinquency_actions (
  id uuid primary key default gen_random_uuid(),
  resman_lease_id text not null,       -- soft ref (lease may be deleted by sync)
  resman_unit_id text not null default '',
  unit_number text not null default '',
  kind text not null check (kind in ('note','called','notice_served','promise_recorded','promise_kept','promise_broken','fed_filed','eviction_completed','writeoff','payment_plan')),
  note text not null default '',
  amount numeric(12,2),                -- legal cost or promise amount, context-dependent
  promise_due_date date,               -- only for promise_recorded / payment_plan
  created_by text not null default '', -- staff display name from token label
  created_by_admin_id text not null default '',
  created_at timestamptz default now(),
  deleted_at timestamptz
);

create index if not exists delinquency_actions_lease_idx
  on public.delinquency_actions (resman_lease_id, deleted_at);
create index if not exists delinquency_actions_unit_idx
  on public.delinquency_actions (resman_unit_id, deleted_at);

-- Service-role only, like the other Emberly-owned tables: RLS on, no policies.
alter table public.delinquency_actions enable row level security;

-- ------------------------------------------------------------
-- renewal_offers — renewal pipeline for the manager app
-- ------------------------------------------------------------
-- Emberly-owned write surface, the delinquency_actions pattern again: every
-- expiring lease moves through a tracked offer flow (needs offer → offer sent
-- → response). ResMan stays the lease of record; Emberly owns the offer
-- workflow. The lease reference is soft — the sync's delete-missing pass may
-- remove a lease, but the offer history (and the lift metric it feeds) must
-- survive. term_months null + is_month_to_month true is the MTM offer; the
-- MTM premium is just the proposed_rent.
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

-- ------------------------------------------------------------
-- insurance_actions — the insurance compliance follow-up trail
-- ------------------------------------------------------------
-- Emberly-owned write surface, the delinquency_actions pattern again: property
-- managers record proof requests, second notices and manual verifications
-- against a lease from the manager app's Compliance board. ResMan stays the
-- source of the policy record (resman_lease_insurance); Emberly owns what we
-- did about it. "Lapse detected" rows are NOT stored — lapse is derived from
-- the policy end date on device. The lease reference is soft — the sync's
-- delete-missing pass may remove a lease, but the follow-up history must
-- survive it.
create table if not exists public.insurance_actions (
  id uuid primary key default gen_random_uuid(),
  resman_lease_id text not null,       -- soft ref (lease may be deleted by sync)
  unit_number text not null default '',
  kind text not null check (kind in ('proof_requested','second_notice','verified','note')),
  note text not null default '',
  created_by text not null default '', -- staff display name from token label
  created_by_admin_id text not null default '',
  created_at timestamptz default now(),
  deleted_at timestamptz
);

create index if not exists insurance_actions_lease_idx
  on public.insurance_actions (resman_lease_id, deleted_at);

-- Service-role only, like the other Emberly-owned tables: RLS on, no policies.
alter table public.insurance_actions enable row level security;

-- ------------------------------------------------------------
-- lease_notes — shared staff notes thread on a lease
-- ------------------------------------------------------------
-- Emberly-owned write surface, the delinquency_actions pattern again: any
-- staff role posts free-text notes against a lease from the manager app's
-- pipeline detail sheet; ResMan is never touched. The lease reference is soft
-- — the sync's delete-missing pass may remove a lease, but the conversation
-- must survive it — so rows are soft deleted (deleted_at) and never cascade.
create table if not exists public.lease_notes (
  id uuid primary key default gen_random_uuid(),
  resman_lease_id text not null,       -- soft ref (lease may be deleted by sync)
  unit_number text not null default '',
  body text not null,
  created_by text not null default '', -- staff display name from token label
  created_by_role text not null default '', -- token role, shown next to the name
  created_by_admin_id text not null default '',
  created_at timestamptz default now(),
  deleted_at timestamptz
);

create index if not exists lease_notes_lease_idx
  on public.lease_notes (resman_lease_id, deleted_at);

-- Service-role only, like the other Emberly-owned tables: RLS on, no policies.
alter table public.lease_notes enable row level security;

-- ------------------------------------------------------------
-- maintenance_work_order_edits — work-order write queue to ResMan
-- ------------------------------------------------------------
-- The durable write queue between the maintenance app and ResMan. The web
-- routes (/api/resman/work-orders/[id]/edit|close) enqueue one row per
-- requested change; the sync worker's flush-work-order-writes job drains it by
-- replaying ResMan's edit form (edits and closes ONLY — delete and cancel are
-- refused by the writer). The work-order reference is soft: a queued row must
-- survive the sync's delete-missing pass, and the flush fails it cleanly if
-- the mirror row is gone. resman_work_orders itself is NEVER written by this
-- path — the mirror absorbs an applied change on the next sync pass.
create table if not exists public.maintenance_work_order_edits (
  id uuid primary key default gen_random_uuid(),
  resman_work_order_id text not null,  -- soft ref (mirror row may be deleted by sync)
  kind text not null check (kind in ('edit','close')),
  patch jsonb not null,                -- edit: technician/description/completionNotes/scheduledAt · close: note/completedAt
  requested_by text not null default '',        -- staff display name from token label
  requested_by_role text not null default '',
  requested_by_admin_id text not null default '',
  status text not null default 'queued' check (status in ('queued','applying','applied','failed','superseded')),
  attempts integer not null default 0,
  last_error text not null default '',
  applied_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- One live queued row per work order and kind: a retried request from the
-- app's offline queue updates the row in place instead of stacking duplicates
-- (the app already merges its patches client-side before re-sending).
create unique index if not exists maintenance_wo_edits_one_queued_idx
  on public.maintenance_work_order_edits (resman_work_order_id, kind)
  where status = 'queued';

create index if not exists maintenance_wo_edits_status_idx
  on public.maintenance_work_order_edits (status, created_at);
create index if not exists maintenance_wo_edits_work_order_idx
  on public.maintenance_work_order_edits (resman_work_order_id);

-- Service-role only, like the other Emberly-owned tables: RLS on, no policies.
alter table public.maintenance_work_order_edits enable row level security;

-- ------------------------------------------------------------
-- mlgw_accounts (from MLGWAccount)
-- ------------------------------------------------------------
create table if not exists public.mlgw_accounts (
  id text primary key,
  resman_property_id text not null default '',    -- soft ref
  property_name text not null default '',
  account_number text not null default '',
  service_address text not null default '',
  resman_unit_id text not null default '',        -- soft ref (heuristic match)
  unit_number text not null default '',
  is_house_account boolean not null default false,
  due_now numeric(12,2),
  due_date date,
  synced_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists mlgw_accounts_resman_property_id_idx on public.mlgw_accounts (resman_property_id);
create index if not exists mlgw_accounts_account_number_idx on public.mlgw_accounts (account_number);
create index if not exists mlgw_accounts_resman_unit_id_idx on public.mlgw_accounts (resman_unit_id);

drop trigger if exists mlgw_accounts_updated_at on public.mlgw_accounts;
create trigger mlgw_accounts_updated_at
  before update on public.mlgw_accounts
  for each row execute function public.update_updated_at_column();

alter table public.mlgw_accounts enable row level security;

-- ------------------------------------------------------------
-- mlgw_bills (from MLGWBill). file_path -> Supabase Storage object path.
-- ------------------------------------------------------------
create table if not exists public.mlgw_bills (
  id text primary key,
  document_key text not null default '',          -- defaults to id if blank
  mlgw_account_id text references public.mlgw_accounts(id) on delete cascade,
  resman_property_id text not null default '',    -- soft
  document_id text not null default '',
  is_current boolean not null default true,
  bill_date date,
  due_date date,
  amount_due numeric(12,2),
  balance_forward numeric(12,2),
  average_temperature numeric(6,2),
  bill_for text not null default '',
  file_path text not null default '',             -- Supabase Storage object path (mlgw-bills bucket)
  gas_usage text not null default '',
  gas_read_start_date date,
  gas_read_end_date date,
  gas_total numeric(12,2),
  electric_usage text not null default '',
  electric_read_start_date date,
  electric_read_end_date date,
  electric_total numeric(12,2),
  water_usage text not null default '',
  water_read_start_date date,
  water_read_end_date date,
  water_total numeric(12,2),
  sewer_usage text not null default '',
  sewer_read_start_date date,
  sewer_read_end_date date,
  sewer_total numeric(12,2),
  other_mlgw_total numeric(12,2),
  non_mlgw_total numeric(12,2),
  street_light_fee_total numeric(12,2),
  electrical_late_fee_total numeric(12,2),
  security_deposit_total numeric(12,2),
  smart_meter_connect_charge_total numeric(12,2),
  credit_balance_transfer_total numeric(12,2),
  share_the_pennies_total numeric(12,2),
  water_cross_connection_fee_total numeric(12,2),
  leasing_outdoor_lighting_total numeric(12,2),
  mosquito_rodent_control_fee_total numeric(12,2),
  sewer_charge_total numeric(12,2),
  storm_water_fee_total numeric(12,2),
  solid_waste_fee_total numeric(12,2),
  synced_at timestamptz default now(),
  raw jsonb,                                       -- parsed bill DTO + charge array
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists mlgw_bills_mlgw_account_id_idx on public.mlgw_bills (mlgw_account_id);
create index if not exists mlgw_bills_resman_property_id_idx on public.mlgw_bills (resman_property_id);
create index if not exists mlgw_bills_document_id_idx on public.mlgw_bills (document_id);
create index if not exists mlgw_bills_bill_date_idx on public.mlgw_bills (bill_date);

drop trigger if exists mlgw_bills_updated_at on public.mlgw_bills;
create trigger mlgw_bills_updated_at
  before update on public.mlgw_bills
  for each row execute function public.update_updated_at_column();

alter table public.mlgw_bills enable row level security;

-- ------------------------------------------------------------
-- mlgw_payments (from MLGWPayment). Card fields intentionally dropped
-- (confirmed 2026-07-11): smallest PII surface — keep amount, date,
-- confirmation, method only; no masked_card_number / name_on_card.
-- ------------------------------------------------------------
create table if not exists public.mlgw_payments (
  id text primary key,                            -- propertyId|payment|<digits>
  mlgw_account_id text references public.mlgw_accounts(id) on delete cascade,
  resman_property_id text not null default '',    -- soft
  account_number text not null default '',
  reference_number text not null default '',
  status text not null default '',
  amount numeric(12,2),
  paid_date date,
  payment_method text not null default '',
  authorization_number text not null default '',
  account_selection text not null default '',
  fetched_at timestamptz default now(),
  detail_fetched_at timestamptz,
  detail_text text not null default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists mlgw_payments_mlgw_account_id_idx on public.mlgw_payments (mlgw_account_id);
create index if not exists mlgw_payments_resman_property_id_idx on public.mlgw_payments (resman_property_id);
create index if not exists mlgw_payments_reference_number_idx on public.mlgw_payments (reference_number);
create index if not exists mlgw_payments_paid_date_idx on public.mlgw_payments (paid_date);

drop trigger if exists mlgw_payments_updated_at on public.mlgw_payments;
create trigger mlgw_payments_updated_at
  before update on public.mlgw_payments
  for each row execute function public.update_updated_at_column();

alter table public.mlgw_payments enable row level security;

-- ------------------------------------------------------------
-- mlgw_exception_reviews (from UtilityExceptionReview)
-- ------------------------------------------------------------
create table if not exists public.mlgw_exception_reviews (
  id text primary key,                            -- propertyId|billId|exceptionKind
  resman_property_id text not null default '',
  bill_id text not null default '',               -- soft ref to mlgw_bills.id
  account_number text not null default '',
  exception_kind text not null default '',
  reviewed_at timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists mlgw_exception_reviews_resman_property_id_bill_id_idx on public.mlgw_exception_reviews (resman_property_id, bill_id);

alter table public.mlgw_exception_reviews enable row level security;

-- ------------------------------------------------------------
-- resman_sync_runs (one row per job execution)
-- ------------------------------------------------------------
create table if not exists public.resman_sync_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  resman_account_id text,
  resman_property_id text,
  status text not null check (status in ('running','succeeded','failed','partial','skipped')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_upserted integer not null default 0,
  rows_failed integer not null default 0,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists resman_sync_runs_job_started_at_idx on public.resman_sync_runs (job, started_at desc);
create index if not exists resman_sync_runs_status_started_at_idx on public.resman_sync_runs (status, started_at desc);

alter table public.resman_sync_runs enable row level security;

-- ------------------------------------------------------------
-- resman_sync_state (per-(job, property) incremental watermark)
-- ------------------------------------------------------------
create table if not exists public.resman_sync_state (
  job text not null,
  resman_property_id text not null default '',
  last_synced_at timestamptz,
  last_run_id uuid references public.resman_sync_runs(id) on delete set null,
  cursor jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (job, resman_property_id)
);

drop trigger if exists resman_sync_state_updated_at on public.resman_sync_state;
create trigger resman_sync_state_updated_at
  before update on public.resman_sync_state
  for each row execute function public.update_updated_at_column();

alter table public.resman_sync_state enable row level security;

-- ------------------------------------------------------------
-- Private storage bucket for downloaded MLGW bill PDFs (service role only).
-- Same pattern as entry-log-photos.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('mlgw-bills', 'mlgw-bills', false)
on conflict (id) do update
set public = excluded.public;
-- Security-camera markers on the property map. Placed and edited only in the
-- admin portal; the guard iPads read them (coverage cones on the map) but can
-- never move, add, or change one — enforced by the API, this table just
-- stores the truth.

create table if not exists public.map_cameras (
  id uuid primary key default gen_random_uuid(),
  normalized_x double precision not null check (normalized_x >= 0 and normalized_x <= 1),
  normalized_y double precision not null check (normalized_y >= 0 and normalized_y <= 1),
  -- Facing in degrees, 0 = up/north on the map.
  direction double precision not null default 0,
  fov double precision not null default 70 check (fov >= 10 and fov <= 180),
  -- Coverage radius as a fraction of the map's width.
  range double precision not null default 0.06 check (range > 0 and range <= 0.5),
  active boolean not null default true,
  -- UniFi Protect pairing (console + camera on that console). Both null = marker only.
  -- The camera's Protect name is resolved and stored at pairing time; it is the
  -- camera's only label.
  unifi_console_id text,
  unifi_camera_id text,
  unifi_camera_name text,
  -- When the name was last reconciled against UniFi (see reconcileCameraNames).
  unifi_camera_name_synced_at timestamptz,
  created_by_display_name text,
  updated_by_display_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists map_cameras_updated_at_idx
  on public.map_cameras (updated_at desc);

-- Shared, expiring unit tags (see migrations/20260722_unit_tags.sql). Ports the
-- Swift UnitTagStore into the synced model; expiration rules run server-side.
create table if not exists public.unit_tags (
  id uuid primary key default gen_random_uuid(),
  unit_number text not null,
  label text not null,
  color_hex text not null default '#5B7C99',
  expiry_kind text not null default 'never'
    constraint unit_tags_expiry_kind_check
      check (expiry_kind in ('never', 'date', 'duration', 'move_out', 'status_change')),
  expires_at timestamptz,
  bound_lease_id text,
  status_trigger text,
  origin text not null default 'admin'
    constraint unit_tags_origin_check check (origin in ('admin', 'scanner')),
  created_by_display_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists unit_tags_unit_number_idx on public.unit_tags (unit_number);
create index if not exists unit_tags_expires_at_idx on public.unit_tags (expires_at);
create unique index if not exists unit_tags_unit_label_uniq
  on public.unit_tags (unit_number, lower(label));
-- Service-role only, like the rest of the first-party tables (the 20260722
-- migration that created unit_tags omitted this line).
alter table public.unit_tags enable row level security;

alter table public.map_cameras enable row level security;
-- No policies: service-role only, like the rest of the first-party tables.

-- Lease deep-capture stamp (see 20260717_lease_deep_synced.sql): terminal
-- leases are skipped on resync only once their children have actually synced.
alter table public.resman_leases
  add column if not exists deep_synced_at timestamptz;

-- Annotation pin glyph (see 20260717_annotation_icons.sql).
alter table public.map_annotations
  add column if not exists icon text not null default 'document-text';

-- Resident entry-token single-use ledger (see 20260724_resident_entry_token_uses.sql):
-- the resident QR carries a unique jti; verify-pass records it here on first scan,
-- so a screenshot/replay within its 60s TTL hits the primary-key conflict and is
-- rejected. Service-role only (RLS on, no policies); expires_at drives cleanup pruning.
create table if not exists public.resident_entry_token_uses (
  jti text primary key,
  resident_id text,
  used_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists resident_entry_token_uses_expires_at_idx
  on public.resident_entry_token_uses (expires_at);
alter table public.resident_entry_token_uses enable row level security;

-- Expo push tokens for the staff apps (see deltas/2026-07-21-push-tokens.sql):
-- the maintenance app registers its device token via POST /api/admin/push-tokens
-- and the sync worker fans emergency work-order alerts out to every active row.
-- `app` is the fleet discriminator ('maintenance' | 'manager') — every sender
-- MUST filter on it so one app's alerts never reach the other's devices.
-- Service-role only (RLS on, no policies), like the rest of the first-party tables.
create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  expo_push_token text not null unique,   -- "ExponentPushToken[...]"; opaque here
  admin_id text not null,                 -- staff subject the app authenticated as
  display_name text not null default '',
  platform text not null default 'ios'
    constraint push_tokens_platform_check check (platform in ('ios', 'android')),
  app text not null default 'maintenance',
  -- Manager app per-kind alert preferences (manager_alert_notifications.kind
  -- values). Empty = no recorded preference = every kind; maintenance rows
  -- leave it empty. See deltas/2026-07-22-manager-alerts.sql.
  alert_kinds text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_seen_at timestamptz default now()
);
create index if not exists push_tokens_active_app_idx on public.push_tokens (app) where active;

drop trigger if exists push_tokens_updated_at on public.push_tokens;
create trigger push_tokens_updated_at
  before update on public.push_tokens
  for each row execute function public.update_updated_at_column();

alter table public.push_tokens enable row level security;

-- ------------------------------------------------------------
-- manager_alert_notifications — the manager app's push-alert ledger.
--
-- One row per alert that has been SENT (or claimed for sending). The sync
-- worker's manager-alerts job inserts the row BEFORE calling Expo, so an
-- alert can fire at most once: (kind, subject_key) is unique and the insert
-- is the claim. `subject_key` is the source row's natural id per kind —
-- resman_lease_id (application_received / lease_signed), resman_unit_id
-- (balance_threshold), delinquency_actions.id (eviction_milestone),
-- mlgw_bills.id (utility_spike), renewal_offers.id (renewal_offer_silent), or
-- resman_lease_insurance.resman_insurance_id (policy_lapsed).
--
-- Only balance_threshold rows are ever removed: the job deletes them once a
-- unit's balance falls back under the re-arm band so a later climb over the
-- threshold can alert again. Every other kind's row is permanent.
--
-- Service-role only (RLS on, no policies).
-- ------------------------------------------------------------
create table if not exists public.manager_alert_notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    constraint manager_alert_notifications_kind_check check (kind in (
      'application_received',
      'lease_signed',
      'balance_threshold',
      'eviction_milestone',
      'utility_spike',
      'renewal_offer_silent',
      'policy_lapsed'
    )),
  subject_key text not null,             -- source row id; unique with kind
  unit_number text not null default '',
  title text not null default '',
  body text not null default '',         -- PII-light copy as sent
  amount numeric(12,2),
  devices integer not null default 0,    -- tokens the alert was addressed to
  notified_at timestamptz not null default now(),
  created_at timestamptz default now(),
  constraint manager_alert_notifications_subject_unique unique (kind, subject_key)
);

create index if not exists manager_alert_notifications_notified_at_idx
  on public.manager_alert_notifications (notified_at desc);

alter table public.manager_alert_notifications enable row level security;

-- ------------------------------------------------------------
-- property_snapshots — one row per property per day, written by the sync
-- worker's nightly snapshots step after the mirror jobs run. The Trends
-- charts read this table directly; no per-request aggregation.
--
-- ALL metric columns are nullable ON PURPOSE: the one-shot backfill
-- reconstructs only what lease spans can prove (the occupancy family) and
-- leaves every other column null, so a null reads as "series not yet begun"
-- and the charts label the series start instead of faking a flat past.
--
-- `source` records which writer produced the row: 'nightly' (the daily job;
-- a same-day re-run overwrites) or 'backfill' (the lease-span reconstruction;
-- it never overwrites an existing row).
--
-- Service-role only (RLS on, no policies).
-- ------------------------------------------------------------
create table if not exists public.property_snapshots (
  snapshot_date date primary key,
  total_units integer,
  occupied_units integer,
  vacant_units integer,
  occupancy_pct numeric(5,2),
  rent_roll numeric(14,2),
  lease_rent_total numeric(14,2),
  balance_total numeric(14,2),
  balance_0_30 numeric(14,2),
  balance_31_60 numeric(14,2),
  balance_61_90 numeric(14,2),
  balance_90_plus numeric(14,2),
  delinquent_units integer,
  turns_in_progress integer,
  open_work_orders integer,
  utility_due numeric(14,2),
  source text not null default 'nightly'
    constraint property_snapshots_source_check check (source in ('nightly','backfill')),
  created_at timestamptz default now()
);

alter table public.property_snapshots enable row level security;

-- ------------------------------------------------------------
-- owner-reports — monthly owner-report archive (Storage bucket)
-- ------------------------------------------------------------
-- The sync worker's monthly job (supabase/sync/src/run-owner-report.ts)
-- renders last month into <YYYY-MM>.pdf / <YYYY-MM>.html plus the FROZEN
-- figures payload <YYYY-MM>.json ("report numbers freeze" — the archive is an
-- audit trail, not a live view). Served to the manager app through
-- /api/resman/manager/reports; no table rows — the bucket listing IS the
-- archive index. Private (service role only), like the other buckets.
insert into storage.buckets (id, name, public)
values ('owner-reports', 'owner-reports', false)
on conflict (id) do update
set public = excluded.public;


-- ============================================================
-- Flattened from lib/supabase/deltas on 2026-08-01
-- ============================================================
--
-- Everything below reached production through a dated delta and is folded in
-- here as its end state, per the convention in migrations/README.md: this file
-- provisions a fresh database on its own, and `deltas/` starts empty again.
--
-- Superseded revisions are NOT reproduced. mcp_aggregate was defined four
-- times and mcp_predicate three as their capabilities grew; only the final
-- definition of each appears here. Replaying the deltas left the earlier
-- overloads behind in the database — `create or replace function` with a new
-- signature creates a new function rather than replacing the old one — and a
-- fresh database built from this file simply never has them.

-- ------------------------------------------------------------
-- unit_snapshots — per-unit daily history
-- ------------------------------------------------------------
-- resman_units is a MIRROR: the sync overwrites it with current state, so
-- yesterday's occupancy is gone the moment it runs. This table is the only
-- record of what a unit looked like on a given day, written nightly by
-- supabase/sync/src/run-unit-snapshots.ts. Keyed (snapshot_date, unit) so a
-- re-run of the same night is an upsert, not a duplicate.
create table unit_snapshots (
  snapshot_date date not null,
  resman_unit_id uuid not null,
  unit_number text,
  resman_building_id uuid,
  resman_floorplan_id uuid,
  occupancy_status text,
  occupied boolean,
  lease_status text,
  availability text,
  balance numeric,
  current_month_balance numeric,
  market_rent numeric,
  lease_rent numeric,
  times_late integer,
  holding_unit boolean,
  excluded_from_occupancy boolean,
  move_in_date date,
  move_out_date date,
  lease_end_date date,
  source text not null default 'nightly'::text,
  created_at timestamptz not null default now(),
  constraint unit_snapshots_pkey PRIMARY KEY (snapshot_date, resman_unit_id)
);

create index unit_snapshots_status_date_idx on unit_snapshots using btree (occupancy_status, snapshot_date);
create index unit_snapshots_unit_date_idx on unit_snapshots using btree (resman_unit_id, snapshot_date DESC);

-- ------------------------------------------------------------
-- monitor_findings — what the monitor noticed, deduplicated
-- ------------------------------------------------------------
-- One row per DISTINCT finding, not per detection: `fingerprint` is unique, so
-- a condition that persists for a week updates last_seen_at instead of filing
-- seven rows. resolved_at is set when a finding stops reproducing, which is
-- what makes "still open" answerable. notified_at records that a digest went
-- out, so a restart cannot re-notify the same finding.
create table monitor_findings (
  id uuid not null default gen_random_uuid(),
  fingerprint text not null,
  kind text not null,
  severity text not null,
  resource text not null,
  entity text,
  period text,
  summary text not null,
  detail jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  constraint monitor_findings_kind_check CHECK ((kind = ANY (ARRAY['anomaly'::text, 'staleness'::text]))),
  constraint monitor_findings_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warn'::text, 'critical'::text]))),
  constraint monitor_findings_pkey PRIMARY KEY (id),
  constraint monitor_findings_fingerprint_key UNIQUE (fingerprint)
);

create index monitor_findings_notify_idx on monitor_findings using btree (notified_at, severity) WHERE (resolved_at IS NULL);
create index monitor_findings_open_idx on monitor_findings using btree (resolved_at, severity, last_seen_at DESC);
create index monitor_findings_resource_idx on monitor_findings using btree (resource, kind);

-- ------------------------------------------------------------
-- access_token_changes — a trail for PERMISSION changes
-- ------------------------------------------------------------
-- access_token_audit_log records what a token DID; this records what was done
-- TO it. See the trigger below for why it is enforced in the database.
create table access_token_changes (
  id uuid not null default gen_random_uuid(),
  token_id uuid not null,
  label text,
  kind text,
  action text not null,
  scopes_before jsonb,
  scopes_after jsonb,
  active_before boolean,
  active_after boolean,
  changed_at timestamptz not null default now(),
  constraint access_token_changes_action_check CHECK ((action = ANY (ARRAY['created'::text, 'scopes_changed'::text, 'revoked'::text, 'reactivated'::text, 'other'::text]))),
  constraint access_token_changes_pkey PRIMARY KEY (id)
);

create index access_token_changes_token_idx on access_token_changes using btree (token_id, changed_at DESC);

-- ============================================================================
-- public.access_token_changes — a trail for PERMISSION changes
-- ============================================================================
--
-- access_token_audit_log records what a token DID. Nothing recorded what was
-- done TO a token: minting, revoking, and — the one that exposed this — widening
-- its scopes. A token's access was changed from 13 resources to 16 during
-- development and the only record was a chat transcript.
--
-- A TRIGGER, not application code, and that is the whole point: the change that
-- revealed the gap was a direct UPDATE against the table. Anything that writes
-- through the API, through psql, or through a migration is caught here, because
-- the database is the one chokepoint none of them can go around.
--
-- Scopes are stored as before/after arrays rather than a diff, so a row answers
-- "what could this token reach on that date" without replaying history.



create or replace function public.log_access_token_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    insert into public.access_token_changes (token_id, label, kind, action, scopes_after, active_after)
    values (new.id, new.label, new.kind, 'created', to_jsonb(new.scopes), new.active);
    return new;
  end if;

  -- Only permission-relevant transitions are logged. last_used_at is bumped on
  -- every authenticated request, and recording those here would bury the four
  -- events a year that actually matter under millions that do not.
  if new.scopes is distinct from old.scopes then
    v_action := 'scopes_changed';
  elsif old.active and not new.active then
    v_action := 'revoked';
  elsif not old.active and new.active then
    v_action := 'reactivated';
  else
    return new;
  end if;

  insert into public.access_token_changes (
    token_id, label, kind, action, scopes_before, scopes_after, active_before, active_after
  ) values (
    new.id, new.label, new.kind, v_action,
    to_jsonb(old.scopes), to_jsonb(new.scopes), old.active, new.active
  );
  return new;
end;
$$;

drop trigger if exists access_tokens_change_log on public.access_tokens;
create trigger access_tokens_change_log
  after insert or update on public.access_tokens
  for each row execute function public.log_access_token_change();

-- Backfill what is still knowable: current state for every existing token, so
-- the trail does not start with an unexplained gap. Marked 'other' rather than
-- 'created', because these are observations, not observed events.
insert into public.access_token_changes (token_id, label, kind, action, scopes_after, active_after, changed_at)
select id, label, kind, 'other', to_jsonb(scopes), active, coalesce(created_at, now())
from public.access_tokens
where not exists (
  select 1 from public.access_token_changes c where c.token_id = access_tokens.id
);

comment on table public.access_token_changes is
  'Permission changes to access_tokens (mint / scope change / revoke). Written by a TRIGGER so direct SQL is caught too — the gap that motivated it was a raw UPDATE.';

-- ------------------------------------------------------------
-- resman_transactions_lease_sequence_idx
-- ------------------------------------------------------------
-- Serves the per-lease ledger read, which walks a lease's entries newest-first
-- by ledger_sequence. Present in production but created by no delta — it was
-- added by hand and would have been lost by any rebuild from these files.
create index if not exists resman_transactions_lease_sequence_idx
  on resman_transactions (resman_lease_id, ledger_sequence desc);

-- ============================================================================
-- mcp_aggregate: cross-resource EXISTS, so a related filter stays in SQL
-- ============================================================================
--
-- Supersedes 2026-08-01-mcp-aggregate-scope-predicates.sql, left as it ran.
--
-- A `related` filter previously forced the whole aggregate onto the PostgREST
-- path, because a join is not something this function could express. Measured:
-- units grouped by building with an open work order cost 29 requests and
-- 3.7 SECONDS — one HEAD count per building, sequentially. That is the exact
-- pathology the RPC was written to kill, reappearing through a side door.
--
-- p_exists adds `[not] exists (select 1 from child c where c.fk = t.pk and …)`.
-- The outer table is now aliased `t` and every predicate is qualified, which
-- matters more than it looks: an unqualified child predicate naming a column
-- the child does not have would bind to the OUTER row and silently filter the
-- wrong table.

create or replace function public.mcp_predicate(p jsonb, p_prefix text default '')
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_col text := case when p_prefix = '' then quote_ident(p ->> 'col')
                     else quote_ident(p_prefix) || '.' || quote_ident(p ->> 'col') end;
  v_op  text := p ->> 'op';
  v_vals text;
begin
  if v_op = 'eq' then      return format('%s = %L', v_col, p ->> 'val');
  elsif v_op = 'neq' then  return format('%s <> %L', v_col, p ->> 'val');
  elsif v_op = 'gte' then  return format('%s >= %L', v_col, p ->> 'val');
  elsif v_op = 'lte' then  return format('%s <= %L', v_col, p ->> 'val');
  elsif v_op = 'is_null' then  return format('%s is null', v_col);
  elsif v_op = 'not_null' then return format('%s is not null', v_col);
  elsif v_op = 'in' then
    if p -> 'vals' is null or jsonb_array_length(p -> 'vals') = 0 then
      return 'false';
    end if;
    select string_agg(quote_literal(value), ', ') into v_vals
      from jsonb_array_elements_text(p -> 'vals');
    return format('%s in (%s)', v_col, v_vals);
  else
    raise exception 'mcp_aggregate: unknown filter op %', v_op;
  end if;
end;
$$;

revoke all on function public.mcp_predicate(jsonb, text) from public;
grant execute on function public.mcp_predicate(jsonb, text) to service_role;

create or replace function public.mcp_aggregate(
  p_table text,
  p_group_by text default null,
  p_period_column text default null,
  p_period_interval text default null,
  -- Non-null means the period column is an INSTANT and must be read in this
  -- zone. Null means a plain DATE, which carries no timezone and must not be
  -- converted — the same date/timestamp split the application layer makes.
  p_period_tz text default null,
  p_metric text default 'count',
  p_measure text default null,
  -- [{"col":"…","op":"eq|neq|gte|lte|in|is_null|not_null","val":"…","vals":[…]}]
  p_filters jsonb default '[]'::jsonb,
  -- Same shape, OR'd together and ANDed with everything else. One group only.
  p_any jsonb default '[]'::jsonb,
  p_search_columns text[] default null,
  p_search_term text default null,
  -- {"table":"…","parent_key":"…","child_key":"…","negate":bool,"filters":[…],"any":[…]}
  -- A cross-resource filter. Previously this forced the whole aggregate onto
  -- the PostgREST path, where a grouped count cost one HEAD request per group
  -- — 29 requests and 3.7s for units-by-building with an open work order.
  p_exists jsonb default null
)
returns table (grp text, period text, n bigint, val numeric)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_allowed constant text[] := array[
    'resman_properties', 'resman_buildings', 'resman_floorplans', 'resman_units',
    'resman_leases', 'resman_residents', 'resman_transactions', 'resman_work_orders',
    'mlgw_accounts', 'mlgw_bills', 'mlgw_payments',
    'guest_passes', 'entry_logs', 'property_snapshots', 'unit_snapshots', 'monitor_findings'
  ];
  v_where   text := 'true';
  v_grp     text := 'null::text';
  v_period  text := 'null::text';
  v_trunc   text;
  v_label   text;
  v_agg     text;
  v_n       text;
  v_search  text := '';
  v_filter  jsonb;
  v_any     text;
  v_exists  text;
  v_child   jsonb;
  v_sql     text;
begin
  if not (p_table = any (v_allowed)) then
    raise exception 'mcp_aggregate: table % is not aggregatable', p_table;
  end if;
  if p_metric not in ('count', 'sum', 'avg', 'min', 'max') then
    raise exception 'mcp_aggregate: unknown metric %', p_metric;
  end if;
  if p_metric <> 'count' and p_measure is null then
    raise exception 'mcp_aggregate: metric % requires a measure', p_metric;
  end if;

  -- --- predicates ---------------------------------------------------------
  for v_filter in select * from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb))
  loop
    v_where := v_where || ' and ' || public.mcp_predicate(v_filter, 't');
  end loop;

  -- The OR group. ANDed as a single parenthesised clause, so a scope can only
  -- ever narrow — it can never pull in rows the other predicates excluded.
  if jsonb_array_length(coalesce(p_any, '[]'::jsonb)) > 0 then
    select string_agg(public.mcp_predicate(elem, 't'), ' or ')
      into v_any
      from jsonb_array_elements(p_any) as elem;
    v_where := v_where || format(' and (%s)', v_any);
  end if;

  -- --- cross-resource filter ----------------------------------------------
  -- Child predicates are prefixed with the child alias `c`, never left bare:
  -- an unqualified name that the child lacks would silently bind to the OUTER
  -- row and quietly filter the wrong table.
  if p_exists is not null then
    if not (p_exists ->> 'table' = any (v_allowed)) then
      raise exception 'mcp_aggregate: related table % is not aggregatable', p_exists ->> 'table';
    end if;
    v_exists := format(
      'select 1 from %I as c where c.%I = t.%I',
      p_exists ->> 'table', p_exists ->> 'child_key', p_exists ->> 'parent_key'
    );
    for v_child in select * from jsonb_array_elements(coalesce(p_exists -> 'filters', '[]'::jsonb))
    loop
      v_exists := v_exists || ' and ' || public.mcp_predicate(v_child, 'c');
    end loop;
    if jsonb_array_length(coalesce(p_exists -> 'any', '[]'::jsonb)) > 0 then
      select string_agg(public.mcp_predicate(elem, 'c'), ' or ')
        into v_any
        from jsonb_array_elements(p_exists -> 'any') as elem;
      v_exists := v_exists || format(' and (%s)', v_any);
    end if;
    v_where := v_where || format(
      ' and %s exists (%s)',
      case when coalesce((p_exists ->> 'negate')::boolean, false) then 'not' else '' end,
      v_exists
    );
  end if;

  -- Search is one OR group ANDed with everything else, so a term can never
  -- widen the result past the filters — the same rule the REST path follows.
  if p_search_term is not null and p_search_columns is not null
     and array_length(p_search_columns, 1) > 0 then
    select string_agg(format('t.%s ilike %L', quote_ident(c), '%' || p_search_term || '%'), ' or ')
      into v_search
      from unnest(p_search_columns) as c;
    v_where := v_where || format(' and (%s)', v_search);
  end if;

  -- --- grouping -----------------------------------------------------------
  if p_group_by is not null then
    v_grp := format('t.%s::text', quote_ident(p_group_by));
  end if;

  if p_period_column is not null then
    if p_period_interval not in ('day', 'week', 'month', 'quarter', 'year') then
      raise exception 'mcp_aggregate: unknown interval %', p_period_interval;
    end if;
    -- date_trunc('week') starts Monday, matching the application's ISO weeks.
    v_trunc := case
      when p_period_tz is null
        then format('date_trunc(%L, %s::timestamp)', p_period_interval, 't.' || quote_ident(p_period_column))
        else format('date_trunc(%L, %s at time zone %L)', p_period_interval, 't.' || quote_ident(p_period_column), p_period_tz)
    end;
    v_label := case p_period_interval
      when 'day'     then 'YYYY-MM-DD'
      when 'week'    then 'YYYY-MM-DD'
      when 'month'   then 'YYYY-MM'
      when 'quarter' then 'YYYY"-Q"Q'
      when 'year'    then 'YYYY'
    end;
    v_period := format('to_char(%s, %L)', v_trunc, v_label);
  end if;

  -- --- measure ------------------------------------------------------------
  if p_metric = 'count' then
    v_agg := 'null::numeric';
    v_n   := 'count(*)';
  else
    -- SQL aggregates already ignore NULLs, which is the semantics the
    -- application had to hand-roll: Number(null) is 0, not NaN, so a missing
    -- value would otherwise land as a real zero and halve an average.
    v_agg := format('%s(t.%s::numeric)', p_metric, quote_ident(p_measure));
    v_n   := format('count(t.%s)', quote_ident(p_measure));
  end if;

  v_sql := format(
    'select %s as grp, %s as period, %s as n, %s as val from %I as t where %s group by 1, 2',
    v_grp, v_period, v_n, v_agg, p_table, v_where
  );
  return query execute v_sql;
end;
$$;

revoke all on function public.mcp_aggregate(
  text, text, text, text, text, text, text, jsonb, jsonb, text[], text, jsonb
) from public;
grant execute on function public.mcp_aggregate(
  text, text, text, text, text, text, text, jsonb, jsonb, text[], text, jsonb
) to service_role;

comment on function public.mcp_aggregate(text, text, text, text, text, text, text, jsonb, jsonb, text[], text, jsonb) is
  'Grouped aggregate for the MCP server. Table is allowlisted; identifiers are quote_ident''d and values quote_literal''d. SECURITY INVOKER by design.';


-- ============================================================================
-- mcp_predicate: add ilike_contains
-- ============================================================================
--
-- A related filter can now carry a SEARCH ("leases where a resident is named
-- X"), and with the EXISTS clause that search has to be expressible in SQL
-- rather than as a PostgREST embedded or(). One op, quoted like every other.
--
-- Replaces only mcp_predicate; mcp_aggregate calls it by name and is untouched.

create or replace function public.mcp_predicate(p jsonb, p_prefix text default '')
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_col text := case when p_prefix = '' then quote_ident(p ->> 'col')
                     else quote_ident(p_prefix) || '.' || quote_ident(p ->> 'col') end;
  v_op  text := p ->> 'op';
  v_vals text;
begin
  if v_op = 'eq' then      return format('%s = %L', v_col, p ->> 'val');
  elsif v_op = 'neq' then  return format('%s <> %L', v_col, p ->> 'val');
  elsif v_op = 'gte' then  return format('%s >= %L', v_col, p ->> 'val');
  elsif v_op = 'lte' then  return format('%s <= %L', v_col, p ->> 'val');
  elsif v_op = 'is_null' then  return format('%s is null', v_col);
  elsif v_op = 'not_null' then return format('%s is not null', v_col);
  elsif v_op = 'ilike_contains' then
    -- The caller's term is already stripped of the characters that would break
    -- a PostgREST or= clause; quote_literal handles the rest. % and _ are LIKE
    -- metacharacters, so they are escaped to stay literal — otherwise a term
    -- containing one silently matches far more than the caller asked for.
    return format('%s ilike %L', v_col,
      '%' || replace(replace(p ->> 'val', '%', '\%'), '_', '\_') || '%');
  elsif v_op = 'in' then
    if p -> 'vals' is null or jsonb_array_length(p -> 'vals') = 0 then
      return 'false';
    end if;
    select string_agg(quote_literal(value), ', ') into v_vals
      from jsonb_array_elements_text(p -> 'vals');
    return format('%s in (%s)', v_col, v_vals);
  else
    raise exception 'mcp_aggregate: unknown filter op %', v_op;
  end if;
end;
$$;

revoke all on function public.mcp_predicate(jsonb, text) from public;
grant execute on function public.mcp_predicate(jsonb, text) to service_role;


-- ============================================================================
-- public.mcp_distincts — exact distinct values, one request
-- ============================================================================
--
-- describe_resource learns each groupable column's domain by paging a
-- 5,000-row SAMPLE: 7 requests and ~580ms on transactions, and 5,000 rows over
-- the wire to compute a handful of counts.
--
-- Worse than the cost, it was a SAMPLE. A rare value outside it simply had no
-- bucket, which reads exactly like a real zero — the failure describe_resource
-- exists to prevent. The application compensated with an "(other)" bucket and a
-- domain_complete flag, both of which are workarounds for not being able to ask
-- the question properly. GROUP BY answers it exactly, for every column at once.

create or replace function public.mcp_distincts(
  p_table text,
  p_columns text[],
  p_cap integer default 25
)
returns table (col text, val text, n bigint)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_allowed constant text[] := array[
    'resman_properties', 'resman_buildings', 'resman_floorplans', 'resman_units',
    'resman_leases', 'resman_residents', 'resman_transactions', 'resman_work_orders',
    'mlgw_accounts', 'mlgw_bills', 'mlgw_payments',
    'guest_passes', 'entry_logs', 'property_snapshots', 'unit_snapshots',
    'monitor_findings'
  ];
  v_parts text[] := '{}';
  v_col text;
begin
  if not (p_table = any (v_allowed)) then
    raise exception 'mcp_distincts: table % is not readable', p_table;
  end if;
  if p_columns is null or array_length(p_columns, 1) is null then
    return;
  end if;

  -- One UNION ALL branch per column, each already ranked and capped, so the
  -- whole domain of every groupable column comes back in a single round trip.
  foreach v_col in array p_columns loop
    v_parts := v_parts || format(
      '(select %L::text as col, %I::text as val, count(*) as n from %I group by 2 order by 3 desc limit %s)',
      v_col, v_col, p_table, greatest(p_cap, 1)
    );
  end loop;

  return query execute array_to_string(v_parts, ' union all ');
end;
$$;

revoke all on function public.mcp_distincts(text, text[], integer) from public;
grant execute on function public.mcp_distincts(text, text[], integer) to service_role;

comment on function public.mcp_distincts(text, text[], integer) is
  'Exact distinct values + counts for several columns in one query. Replaces a paged 5,000-row sample, so a rare value can no longer be missing from a reported domain.';
