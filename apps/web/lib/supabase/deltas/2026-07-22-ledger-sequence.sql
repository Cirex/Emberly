-- Parity fix: resman_transactions.ledger_sequence is written by the sync
-- worker (intra-day running-balance order within a lease's ledger) and typed
-- in types/database.ts, but never made it into schema.sql or a delta. A
-- database created from schema.sql before this delta lacks the column and the
-- sync's upserts would fail. Idempotent.
alter table public.resman_transactions
  add column if not exists ledger_sequence integer;
