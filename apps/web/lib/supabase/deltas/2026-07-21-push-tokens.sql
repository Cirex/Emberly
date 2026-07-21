-- Expo push tokens for the staff apps. The maintenance app registers its
-- device token via POST /api/admin/push-tokens; the sync worker fans
-- emergency work-order alerts out to every active row. Brings a database
-- matching the pre-push-tokens schema.sql up to the new shape.
-- Service-role only (RLS on, no policies), like the rest of the
-- first-party tables.

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
