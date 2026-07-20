/**
 * ResMan unit-detail deep-scrape layer — port of ResManUnitDetailScraper.swift +
 * the pure upsert-mappers of ResManUnitDetailSync.swift.
 *   types.ts       — scrape-result dicts + row DTOs for the 8 target tables
 *   parse.ts       — HTML/regex/coercion helpers + ledgerPath
 *   http.ts        — ResManScrapeHttp (over the rate-limited client) + concurrency
 *   unit-detail.ts — scrapeUnit / scrapeLease / residents / buildingFloorplans → dicts
 *   ledger.ts      — mapLedgerRows → resman_transactions
 *   leases.ts      — mapLease / mapLeaseTabs (+ lease-status predicates)
 *   residents.ts   — mapResidents (+ per-tab mappers)
 */
export * from "./types";
export * from "./parse";
export * from "./http";
export * from "./unit-detail";
export * from "./ledger";
export * from "./leases";
export * from "./residents";
