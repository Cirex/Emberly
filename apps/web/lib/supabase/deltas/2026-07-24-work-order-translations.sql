-- Server-side translation cache for work-order prose.
--
-- The sync worker translates work-order title/notes/completion_notes via Langbly
-- and stores the results here, keyed by a content hash of the SOURCE text
-- (packages/core textHash) plus the target language. The maintenance app reads
-- this and merges it into its on-device cache under the identical
-- `${lang}:${hash}` key, so a phone never re-translates prose the server already
-- did. Content-addressed: when a work order's text changes, its hash changes,
-- a new row is written, and the stale row is reaped (source_hash no longer live).

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

-- Read-only to the app via the service role; RLS on with no anon policy keeps
-- it server-authoritative, consistent with the resman_* mirror tables.
alter table work_order_translations enable row level security;
