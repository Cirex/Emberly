-- Two new manager push-alert kinds: renewal_offer_silent (a renewal offer
-- unanswered for more than 10 days; subject_key = renewal_offers.id) and
-- policy_lapsed (a current lease's best renter's-insurance policy whose
-- end_date crossed into the past; subject_key = resman_insurance_id).
--
-- Only the ledger's kind check constraint has to widen — push_tokens.alert_kinds
-- is a free-form text[] and needs nothing. Drop + re-add so this delta also
-- fixes a database that already ran 2026-07-22-manager-alerts.sql (whose
-- `create table if not exists` would leave the old five-kind constraint alone).
-- Existing rows all use the original five kinds, so re-validation cannot fail.

alter table public.manager_alert_notifications
  drop constraint if exists manager_alert_notifications_kind_check;

alter table public.manager_alert_notifications
  add constraint manager_alert_notifications_kind_check check (kind in (
    'application_received',
    'lease_signed',
    'balance_threshold',
    'eviction_milestone',
    'utility_spike',
    'renewal_offer_silent',
    'policy_lapsed'
  ));
