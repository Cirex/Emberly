/**
 * ResMan sync jobs (idempotent upsert-into-Supabase). Each job:
 * ensureAuthenticated -> fetch report -> parse -> map -> upsertMirror. Design §3.3.
 *
 *   units.ts            — All Units -> resman_units (authoritative; seeds resman_properties)
 *   available-units.ts  — Available Units -> enrich resman_units (leasing fields)
 *   unit-info.ts        — Unit Info -> enrich resman_units (address/accessibility; seeds resman_buildings)
 *   delinquency.ts      — Delinquency with Aging -> enrich resman_units (balances)
 */
export * from "./units";
export * from "./available-units";
export * from "./unit-info";
export * from "./delinquency";
export * from "./work-orders";
export * from "./unit-detail";
