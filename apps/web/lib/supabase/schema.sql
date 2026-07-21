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
-- Row-Level Security (RLS)
-- ------------------------------------------------------------
-- Enable RLS on all tables; service role bypasses RLS
alter table residents enable row level security;
alter table guest_passes enable row level security;
alter table entry_logs enable row level security;
alter table entry_log_photos enable row level security;
alter table guest_pass_bans enable row level security;

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
-- on first successful login. key_hash is a legacy column from the retired shared
-- ADMIN_LOGIN_KEY model — nullable and no longer checked.
create table admin_users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  display_name text,
  role text not null check (role in ('super_admin', 'property_manager', 'security_manager', 'viewer')),
  key_hash text unique,
  resman_username text,
  resman_person_id text,
  last_login_at timestamptz,
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index admin_users_active_idx on admin_users (active);
create index admin_users_role_idx on admin_users (role);
create unique index admin_users_resman_username_idx
  on admin_users (resman_username)
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

create or replace function check_rate_limit(
  p_bucket text,
  p_max_attempts integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
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

create table if not exists public.map_sync_access_requests (
  id uuid primary key default gen_random_uuid(),
  resman_account_id text not null,
  property_id text not null,
  property_name text not null,
  feature_key text not null,
  requester_display_name text,
  requester_resman_login_hash text,
  device_id text not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'claimed', 'revoked')),
  claim_token_hash text,
  approved_by text,
  approved_at timestamptz,
  rejected_by text,
  rejected_at timestamptz,
  rejection_reason text,
  revoked_by text,
  revoked_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists map_sync_access_requests_scope_idx
  on public.map_sync_access_requests (resman_account_id, property_id, feature_key, device_id);

create index if not exists map_sync_access_requests_status_idx
  on public.map_sync_access_requests (status, created_at desc);

create unique index if not exists map_sync_access_requests_active_unique_idx
  on public.map_sync_access_requests (resman_account_id, property_id, feature_key, device_id)
  where status in ('pending', 'approved');

drop trigger if exists map_sync_access_requests_updated_at on public.map_sync_access_requests;
create trigger map_sync_access_requests_updated_at
  before update on public.map_sync_access_requests
  for each row execute function public.update_updated_at_column();

alter table public.map_sync_access_requests enable row level security;

create table if not exists public.map_sync_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text unique not null,
  resman_account_id text not null,
  property_id text not null,
  property_name text not null,
  feature_key text not null,
  capabilities jsonb not null default '{"read":true,"create":true,"update":true,"delete":true}'::jsonb,
  requester_display_name text,
  requester_resman_login_hash text,
  device_id text not null,
  active boolean not null default true,
  last_used_at timestamptz,
  revoked_by text,
  revoked_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists map_sync_keys_scope_idx
  on public.map_sync_keys (resman_account_id, property_id, feature_key, active);

create unique index if not exists map_sync_keys_scope_reference_idx
  on public.map_sync_keys (id, resman_account_id, property_id, feature_key);

create unique index if not exists map_sync_keys_active_scope_device_unique_idx
  on public.map_sync_keys (resman_account_id, property_id, feature_key, device_id)
  where active is true;

create index if not exists map_sync_keys_device_idx
  on public.map_sync_keys (device_id, created_at desc);

alter table public.map_sync_keys enable row level security;

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
  utility_type text
    constraint map_annotations_utility_type_check
    check (utility_type is null or utility_type in ('water', 'sewer', 'gas', 'electrical', 'other')),
  -- For kind='utility_line': ordered array of {x, y} objects, each normalized
  -- 0..1 against the map image. Null for pin kinds.
  points jsonb,
  origin text not null default 'sync'
    constraint map_annotations_origin_check check (origin in ('sync', 'admin', 'scanner')),
  created_by_key_id uuid,
  created_by_display_name text,
  created_by_resman_login_hash text,
  created_at timestamptz default now(),
  updated_by_key_id uuid,
  updated_by_display_name text,
  updated_at timestamptz default now(),
  deleted_by_key_id uuid,
  deleted_by_display_name text,
  deleted_at timestamptz,
  version integer not null default 1 check (version > 0),
  constraint map_annotations_feature_key_check check (feature_key = 'property_map.annotations'),
  constraint map_annotations_created_key_scope_fkey
    foreign key (created_by_key_id, resman_account_id, property_id, feature_key)
    references public.map_sync_keys (id, resman_account_id, property_id, feature_key),
  constraint map_annotations_updated_key_scope_fkey
    foreign key (updated_by_key_id, resman_account_id, property_id, feature_key)
    references public.map_sync_keys (id, resman_account_id, property_id, feature_key),
  constraint map_annotations_deleted_key_scope_fkey
    foreign key (deleted_by_key_id, resman_account_id, property_id, feature_key)
    references public.map_sync_keys (id, resman_account_id, property_id, feature_key)
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
  -- Either a map-sync key (external client) or a plain first-party actor.
  created_by_key_id uuid,
  created_by text not null default '',
  created_at timestamptz default now(),
  deleted_at timestamptz,
  constraint map_annotation_photos_feature_key_check check (feature_key = 'property_map.annotations'),
  constraint map_annotation_photos_annotation_scope_fkey
    foreign key (annotation_id, resman_account_id, property_id, feature_key)
    references public.map_annotations (id, resman_account_id, property_id, feature_key)
    on delete cascade,
  constraint map_annotation_photos_created_key_scope_fkey
    foreign key (created_by_key_id, resman_account_id, property_id, feature_key)
    references public.map_sync_keys (id, resman_account_id, property_id, feature_key)
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
  sync_key_id uuid,
  actor_display_name text,
  actor_resman_login_hash text,
  admin_user_id text,
  admin_display_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  constraint map_annotation_audit_logs_annotation_scope_fkey
    foreign key (annotation_id, resman_account_id, property_id, feature_key)
    references public.map_annotations (id, resman_account_id, property_id, feature_key),
  constraint map_annotation_audit_logs_sync_key_scope_fkey
    foreign key (sync_key_id, resman_account_id, property_id, feature_key)
    references public.map_sync_keys (id, resman_account_id, property_id, feature_key)
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

-- ------------------------------------------------------------
-- resman_companies (config/tenant; no credentials stored here)
-- ------------------------------------------------------------
create table if not exists public.resman_companies (
  resman_account_id text primary key,
  subdomain text not null,
  company_name text not null default '',
  consumer_base_url text not null default '',
  auth_base_url text not null default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

drop trigger if exists resman_companies_updated_at on public.resman_companies;
create trigger resman_companies_updated_at
  before update on public.resman_companies
  for each row execute function public.update_updated_at_column();

alter table public.resman_companies enable row level security;

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
  resman_floorplan_id text references public.resman_floorplans(resman_floorplan_id) on delete set null,
  number text not null default '',
  current_lease_id text,               -- denormalized, nullable (no FK)
  pending_lease_id text,               -- denormalized, nullable
  availability text not null default '',
  lease_status text check (lease_status is null or lease_status in ('Current','Under Eviction','Notice to Vacate','Month to Month','Pending','Pending Renewal','Cancelled')),
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
  pets_permitted boolean,
  affordable_unit boolean,
  holding_unit boolean,
  excluded_from_occupancy boolean,
  available_for_online_marketing boolean,
  street text not null default '',
  city text not null default '',
  state text not null default '',
  postal_code text not null default '',
  country text not null default '',
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

drop trigger if exists resman_units_updated_at on public.resman_units;
create trigger resman_units_updated_at
  before update on public.resman_units
  for each row execute function public.update_updated_at_column();

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
  parking_spot text not null default '',
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
  other_income_source text not null default '',
  monthly_income numeric(12,2),
  other_income numeric(12,2),
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
  start_date date,
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
  start_date date,
  end_date date,
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
  unit_lease_group_id text not null default '',
  resman_lease_id text not null default '',
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

drop trigger if exists resman_work_orders_updated_at on public.resman_work_orders;
create trigger resman_work_orders_updated_at
  before update on public.resman_work_orders
  for each row execute function public.update_updated_at_column();

alter table public.resman_work_orders enable row level security;

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
  created_by_key_id uuid,
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
-- Service-role only (RLS on, no policies), like the rest of the first-party tables.
create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  expo_push_token text not null unique,   -- "ExponentPushToken[...]"; opaque here
  admin_id text not null,                 -- staff subject the app authenticated as
  display_name text not null default '',
  platform text not null default 'ios'
    constraint push_tokens_platform_check check (platform in ('ios', 'android')),
  app text not null default 'maintenance',
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
