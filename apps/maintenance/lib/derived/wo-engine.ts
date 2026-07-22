/**
 * The ported Swift duplicate/callback engine. PROMOTED to @emberly/core
 * (packages/core/src/work-order-signals.ts) so the manager app's Work tab can
 * flag callbacks from the same rules; this module stays as the app's import
 * path and public API.
 */
export { computeWorkOrderSignals } from "@emberly/core";
export type { EngineOrder, WorkOrderSignal } from "@emberly/core";
