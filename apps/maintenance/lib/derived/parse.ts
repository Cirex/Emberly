/**
 * Work-order parsing. PROMOTED to @emberly/core (packages/core/src/
 * work-orders.ts) — the manager app parses the same mirror rows with the same
 * make-ready fold, technician normalization, and callback/duplicate engine —
 * so this module is the app's import path onto it.
 */
export { isMakeReadyCategory, parseAll, parseWorkOrder, technicianDisplayName } from "@emberly/core";
