-- ============================================================================
-- monitor_findings.notified_at — send once, not every night
-- ============================================================================
--
-- A finding persists for as long as the problem does, and the monitor updates
-- it in place. Without a record of what has been announced, the notifier would
-- re-alert on every run for as long as a problem lasted — which is how people
-- learn to turn alerts off, and then miss the one that mattered.
--
-- Null means "never announced". Set once, when a digest containing this finding
-- is actually accepted by the push API; a failed send leaves it null so the
-- next run retries rather than dropping it silently.
--
-- Cleared when a finding RESOLVES and later recurs, because the same problem
-- coming back is news again.

alter table public.monitor_findings
  add column if not exists notified_at timestamptz;

-- The notifier's read: which of these fingerprints still need announcing.
create index if not exists monitor_findings_notify_idx
  on public.monitor_findings (notified_at, severity)
  where resolved_at is null;

comment on column public.monitor_findings.notified_at is
  'When a push digest containing this finding was accepted. Null = never announced; cleared on recurrence so a returning problem alerts again.';
