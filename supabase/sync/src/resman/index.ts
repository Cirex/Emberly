/**
 * ResMan sync module — port of the Kraken ResMan services (design §3).
 *
 * Milestone 2 shipped the shared primitives below. Milestone 3 fills in the
 * scrapers/ reports/ jobs/ derive/ subtrees on top of them.
 *
 *   client.ts          — authenticated HTTP client + OIDC login + rate-limited choke point
 *   config.ts          — company/account/subdomain + derived base URLs + tuning (resman_companies)
 *   session-store.ts   — persist the cookie jar between cron runs
 *   scheduler.ts       — bounded-concurrency request scheduler (sequential within a worker)
 *   csv.ts             — DevExpress CSV parser + header lookup + scalar parsers
 *   reports.ts         — DevExpress report driver (viewer token + export form)
 *   normalize.ts       — name / phone normalization
 *   format.ts          — currency + date formatting/parsing
 *   errors.ts          — discriminated scraping error union
 *   cookies.ts         — per-company cookie jar (Set-Cookie parsing lifted from resman-portal.ts)
 */

export * from "./config";
export * from "./errors";
export * from "./format";
export * from "./normalize";
export * from "./csv";
export * from "./scheduler";
export * from "./cookies";
export * from "./session-store";
export * from "./client";
export * from "./report-service";
