/**
 * MLGW sync module — TypeScript port of the ~80-file Kraken MLGW subsystem
 * (KrakenCore/Services/MLGW). Logs into MLGW via SAML SSO and reads bills +
 * payment history from the FIS Global bill-presentment portal, upserting into
 * the mlgw_* mirror tables.
 *
 * ⚠ Blind port: typecheck-verified only, never run against the live portal
 * (no credentials/fixtures). The PDF-text extraction seam is unimplemented.
 *
 * Public API: the `syncMlgwBills` / `syncMlgwPayments` jobs and shared types.
 * Internal groups (session, bill-list, download, parse, payment, http, text)
 * are imported directly where needed.
 */
export * from "./jobs";
export * from "./types";
