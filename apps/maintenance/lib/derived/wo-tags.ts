/**
 * Work-order tag derivation. The engine itself was PROMOTED to @emberly/core
 * (packages/core/src/work-order-tags.ts) so the manager app can derive the same
 * tags; this module stays as the app's import path.
 */
export { deriveWorkOrderTags } from "@emberly/core";
