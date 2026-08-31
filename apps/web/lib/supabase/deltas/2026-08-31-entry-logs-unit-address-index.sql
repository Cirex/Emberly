-- entry_logs gets the (unit_address, entered_at desc) index its reads assume.
--
-- `unit_address` is a first-class filter — the resman entry-logs resource
-- exposes `?unit_address=`, and the per-unit detail pane answers "last entry"
-- with `where unit_address = $1 order by entered_at desc limit 1`. With only
-- `entry_logs_entered_at_idx` to work with, that lookup walks the table
-- newest-first until it happens to meet the unit, so a quiet unit costs a scan
-- of every entry logged since its last one — and the cost grows with the log,
-- not with the answer.
--
-- Composite rather than a plain `(unit_address)` index so the sort is satisfied
-- by the index too: the match is one range and the newest row is its first
-- entry. Mirrors the shape already in place for the scanner lookup
-- (`entry_logs_scanner_entered_at_idx`).
create index if not exists entry_logs_unit_address_entered_at_idx
  on public.entry_logs (unit_address, entered_at desc);
