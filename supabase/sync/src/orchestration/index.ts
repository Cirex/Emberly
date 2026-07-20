/**
 * Orchestration — the Coolify cron scheduler + ordered pipeline (design §5).
 *
 * A single scheduler runs an ordered, dependency-aware pipeline:
 *   resman.properties -> resman.units -> resman.unit_detail
 *     (-> ledgers / resident-tabs / lease-history) -> resman.work_orders
 *   mlgw.bills -> mlgw.payments        (independent lane, may run in parallel)
 *
 * Each step opens a resman_sync_runs row (status=running), updates
 * rows_upserted/rows_failed, and closes it succeeded/partial/failed. Per-property
 * watermarks + cursors live in resman_sync_state. A step only starts if its
 * predecessor's run is succeeded/partial. Idempotent re-runs converge to the
 * same state.
 *
 * Milestone 0: placeholder. The scheduler + Dockerfile land in Milestone 6.
 */
export {};
