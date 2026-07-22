/**
 * MLGW shared contracts — the cross-module types, DTOs, result/metadata
 * structs, errors, cookie, and DB-row shapes every other MLGW module imports.
 *
 * Ports (KrakenCore/Sources/KrakenCore/Services/MLGW/ unless noted):
 *   - MLGWHTTPResponse.swift          -> HTTPResponse
 *   - MLGWScriptErrors.swift          -> ScriptError, BillDownloadFailure
 *   - MLGWStoredCookie.swift          -> MLGWStoredCookie
 *   - MLGWSyncConfig.swift            -> MLGWSyncProperty, BackgroundSyncWorkerConfiguration
 *   - MLGWSession.swift               -> MLGWSyncJob, MLGWSessionResult
 *   - MLGWBillDTO.swift               -> MLGWBillDTO (+ nested Charge)
 *   - MLGWDownloadedBillTypes.swift   -> DownloadedBill, BillDocumentStatus,
 *                                        BillListDocumentMetadata, MLGWPaymentDTO,
 *                                        MLGWDownloadResult, MLGWPaymentDownloadResult,
 *                                        MLGWScriptSyncResult
 *   - MLGWBillSummaries.swift         -> BillJSONSummary, BillJSONCharge
 *   - MLGWParsedBillTypes.swift       -> ParsedBill, ParsedCharge
 *   - MLGWSyncSupport.swift           -> MLGWScriptCancellation
 *   - Core/.../UtilityCredentials.swift (ResMan/UtilityCredentials.swift) ->
 *                                        UtilityProvider, UtilityCredentials
 *
 * Persistence rule (brief §1): parsers/importers return plain DTOs; the job layer
 * maps them to the snake_case `mlgw_*` rows at the bottom of this file and
 * upserts via `upsertMirror`. No SwiftData; no disk. Optional DTO dates are
 * `Date | null`; row date columns are ISO `string | null`.
 */

// MARK: - HTTP response (MLGWHTTPResponse.swift)

/**
 * A completed HTTP response. Swift exposed `text`/`contentType`/`isPDF`/`isHTML`
 * as computed properties over `Data`; here they are precomputed by the client
 * (brief §5): `text` and `bytes` are both materialized, `isPdf` is decided from
 * the content-type or the `%PDF` magic bytes.
 */
export interface HTTPResponse {
  status: number;
  /** Response headers, keys lowercased (as `fetch` returns them). */
  headers: Record<string, string>;
  /** The final URL after manual redirect following. */
  url: string;
  text: string;
  bytes: Uint8Array;
  isPdf: boolean;
}

/** `content-type` contains "html", or the body contains a `<html` tag. */
export function responseIsHtml(response: HTTPResponse): boolean {
  const contentType = (response.headers["content-type"] ?? "").toLowerCase();
  return contentType.includes("html") || /<html/i.test(response.text);
}

// MARK: - Errors (MLGWScriptErrors.swift)

export type ScriptErrorKind = "badResponse" | "pdfKitUnavailable" | "ssoFailed" | "noBillsDownloaded";

/**
 * Port of the Swift `ScriptError` enum-with-associated-values. Modeled the same
 * way as `ResManScrapingError`: a single `Error` subclass carrying a
 * discriminated `kind`, so `instanceof` and `kind`-switching both work. The
 * `message`/`description` matches the Swift `CustomStringConvertible`.
 */
export class ScriptError extends Error {
  readonly kind: ScriptErrorKind;

  private constructor(kind: ScriptErrorKind, message: string) {
    super(message);
    this.name = "ScriptError";
    this.kind = kind;
    Object.setPrototypeOf(this, ScriptError.prototype);
  }

  static badResponse(message: string): ScriptError {
    return new ScriptError("badResponse", message);
  }

  static pdfKitUnavailable(): ScriptError {
    return new ScriptError("pdfKitUnavailable", "PDFKit is not available in this build.");
  }

  static ssoFailed(message: string): ScriptError {
    return new ScriptError("ssoFailed", `MLGW/FIS SSO failed: ${message}`);
  }

  static noBillsDownloaded(): ScriptError {
    return new ScriptError("noBillsDownloaded", "No bill files were downloaded.");
  }

  /** Mirrors the Swift `LocalizedError.errorDescription`. */
  get errorDescription(): string {
    return this.message;
  }
}

/**
 * A single bill target that came back as a non-PDF / error response. Port of the
 * Swift `BillDownloadFailure` struct; the `errorDescription` string is byte-for-byte.
 */
export class BillDownloadFailure extends Error {
  readonly index: number;
  readonly url: string;
  readonly statusCode: number;
  readonly contentType: string;

  constructor(index: number, url: string, statusCode: number, contentType: string) {
    super(
      `Bill target ${index + 1} returned HTTP ${statusCode} with content-type '${contentType}' from ${url}.`,
    );
    this.name = "BillDownloadFailure";
    this.index = index;
    this.url = url;
    this.statusCode = statusCode;
    this.contentType = contentType;
    Object.setPrototypeOf(this, BillDownloadFailure.prototype);
  }

  get errorDescription(): string {
    return this.message;
  }
}

// MARK: - Cancellation (MLGWSyncSupport.swift)

/** Thrown by `MLGWScriptCancellation.check()`; the JS analog of Swift `CancellationError`. */
export class CancellationError extends Error {
  constructor() {
    super("The operation was cancelled.");
    this.name = "CancellationError";
    Object.setPrototypeOf(this, CancellationError.prototype);
  }
}

/**
 * Cooperative cancellation token (brief §7) — the port of the Swift
 * `MLGWScriptCancellation` actor-free class. Threads through the scrapers in
 * place of `Task.checkCancellation()`. An optional `AbortSignal` can back it so
 * callers may cancel through the standard Web API; the no-arg default never cancels.
 */
export class MLGWScriptCancellation {
  private flagged = false;
  private readonly signal?: AbortSignal;

  constructor(signal?: AbortSignal) {
    this.signal = signal;
  }

  cancel(): void {
    this.flagged = true;
  }

  get cancelled(): boolean {
    return this.flagged || (this.signal?.aborted ?? false);
  }

  /** Throws `CancellationError` when cancelled; a no-op otherwise. */
  check(): void {
    if (this.cancelled) throw new CancellationError();
  }
}

// MARK: - Stored cookie (MLGWStoredCookie.swift)

/**
 * A cookie captured by `MLGWHTTPCookieJar`. Ported as a class so the Swift
 * `applies(to:)` method has a home; the jar keys instances by `domain|path|name`.
 */
export class MLGWStoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;

  constructor(name: string, value: string, domain: string, path: string, secure: boolean) {
    this.name = name;
    this.value = value;
    this.domain = domain;
    this.path = path;
    this.secure = secure;
  }

  /** Faithful port of `MLGWStoredCookie.applies(to:)` — domain/path/scheme match. */
  applies(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    if (host.length === 0) return false;
    const cookieDomain = this.domain.toLowerCase();
    const domainMatches =
      host === cookieDomain ||
      (cookieDomain.startsWith(".") && host.endsWith(cookieDomain)) ||
      host.endsWith("." + cookieDomain);
    const urlPath = url.pathname;
    const pathMatches = urlPath.length === 0 || urlPath.startsWith(this.path);
    const schemeMatches = !this.secure || url.protocol.toLowerCase() === "https:";
    return domainMatches && pathMatches && schemeMatches;
  }
}

// MARK: - Credentials (ResMan/UtilityCredentials.swift)

export type UtilityProvider = "MLGW";

/** Injected utility-portal credentials (brief §5 style — never hardcoded). */
export interface UtilityCredentials {
  provider: UtilityProvider;
  login: string;
  password: string;
}

export function emptyUtilityCredentials(provider: UtilityProvider = "MLGW"): UtilityCredentials {
  return { provider, login: "", password: "" };
}

// MARK: - Sync config (MLGWSyncConfig.swift)

/** Lightweight property descriptor used across the MLGW sync layer. */
export interface MLGWSyncProperty {
  id: string;
  name: string;
}

/**
 * Worker-pool sizing for the background sync (Swift
 * `BackgroundSyncWorkerConfiguration`): default 6, clamped to 1...24.
 */
export const BackgroundSyncWorkerConfiguration = {
  defaultWorkerCount: 6,
  workerCountRange: { lowerBound: 1, upperBound: 24 } as const,
  clampedWorkerCount(requested: number): number {
    return Math.min(
      Math.max(this.workerCountRange.lowerBound, requested),
      this.workerCountRange.upperBound,
    );
  },
} as const;

// MARK: - Sync job + session result (MLGWSession.swift)

/** One unit of MLGW work: a property, its credentials, and known-document set. */
export interface MLGWSyncJob {
  property: MLGWSyncProperty;
  credentials: UtilityCredentials;
  backgroundSyncWorkerCount: number;
  /** Document ids already stored, so their PDFs are skipped. */
  knownDocumentIds: Set<string>;
}

/** Result of `MLGWSession.downloadBills` — DTO records + status/payment side data. */
export interface MLGWSessionResult {
  records: MLGWBillDTO[];
  documentStatuses: BillDocumentStatus[];
  payments: MLGWPaymentDTO[];
  downloadedDocuments: number;
  skippedKnownDocuments: number;
}

// MARK: - Bill DTO (MLGWBillDTO.swift)

/**
 * One charge line on a bill DTO. All fields are the string form the Swift DTO
 * serialized (the numeric coercion happens in the job-layer row mapper).
 * `readStartDate`/`readEndDate` default to "" when absent (Swift
 * `decodeIfPresent ?? ""`).
 */
export interface MlgwBillChargeDTO {
  type: string;
  usage: string;
  total: string;
  readStartDate: string;
  readEndDate: string;
}

/**
 * The bill DTO the parsers emit and the job layer maps into `mlgw_bills`.
 * Faithful field set of the Swift `MLGWBillDTO` (all string-valued; `isCurrent`
 * defaults true when absent).
 */
export interface MLGWBillDTO {
  accountNumber: string;
  documentId: string;
  isCurrent: boolean;
  billDate: string;
  amountDue: string;
  balanceForward: string;
  averageTemperature: string;
  dueDate: string;
  billFor: string;
  servicesAt: string;
  filePath: string;
  charges: MlgwBillChargeDTO[];
}

// MARK: - Parsed bill (MLGWParsedBillTypes.swift)

/**
 * A charge as produced by the low-level parsers, before summary aggregation.
 * Swift `Charge` used `Decimal` for `amount`; here it is a `number` (brief §10 —
 * reuse `parseDouble`). Renamed from `Charge` to avoid colliding with the DTO
 * charge shape.
 */
export interface ParsedCharge {
  type: string;
  usage: string | null;
  amount: number;
  readStartDate: string | null;
  readEndDate: string | null;
}

/**
 * A fully parsed bill before it is flattened into a `BillJSONSummary`. Swift
 * used `Decimal?`; here optional decimals are `number | null`.
 */
export interface ParsedBill {
  documentId: string;
  isCurrent: boolean;
  accountNumber: string;
  billDate: string;
  amountDue: number | null;
  balanceForward: number | null;
  averageTemperature: number | null;
  dueDate: string;
  billFor: string;
  servicesAt: string;
  filePath: string;
  charges: ParsedCharge[];
}

// MARK: - Bill summaries (MLGWBillSummaries.swift)

/** A single aggregated charge line in a bill summary (all string-valued). */
export interface BillJSONCharge {
  type: string;
  usage: string;
  total: string;
  readStartDate: string;
  readEndDate: string;
}

/**
 * The JSON-serializable bill summary that `MLGWScriptCore` returns and
 * `MLGWSession` maps into `MLGWBillDTO`. Same field set as `MLGWBillDTO` with an
 * aggregated `charges` array.
 */
export interface BillJSONSummary {
  documentId: string;
  isCurrent: boolean;
  accountNumber: string;
  billDate: string;
  amountDue: string;
  balanceForward: string;
  averageTemperature: string;
  dueDate: string;
  billFor: string;
  servicesAt: string;
  filePath: string;
  charges: BillJSONCharge[];
}

// MARK: - Downloaded-bill types (MLGWDownloadedBillTypes.swift)

/**
 * A downloaded bill artifact. `filePath` is the object path once stored in the
 * `mlgw-bills` bucket (brief §2 — bytes are held in memory, never on disk).
 * Optional fields mirror the Swift optionals.
 */
export interface DownloadedBill {
  documentId: string | null;
  isCurrent: boolean;
  accountNumber: string | null;
  address: string | null;
  amountDue: string | null;
  dueDate: string | null;
  rowText: string | null;
  /**
   * The stored INVOICE path — always a PDF (MLGW's own, or the browser-rendered
   * capture of the bill page) or "" when neither could be produced. Never an
   * HTML path: the portal serves this straight to the user as the invoice.
   */
  filePath: string;
  /**
   * The stored self-contained HTML capture of the bill page (same stem as
   * `filePath`), or "" — the archival copy, kept even when PDF rendering fails.
   */
  capturedHtmlPath?: string;
  extractedText: string | null;
  parseSource: string | null;
}

/** Whether a given document id is the current bill (Swift `BillDocumentStatus`). */
export interface BillDocumentStatus {
  documentId: string;
  isCurrent: boolean;
}

/** Row metadata scraped from the bill list before the PDF is fetched. */
export interface BillListDocumentMetadata {
  documentId: string;
  isCurrent: boolean;
  accountNumber: string;
  serviceAddress: string;
  amountDue: string;
  dueDate: string;
}

/**
 * A scraped payment. Card fields are KEPT in this in-memory DTO but are
 * intentionally DROPPED at DB time (brief §"DROP ALL CARD FIELDS"; the row
 * mapper omits them). `detailFetchedAt` is `Date | null`.
 */
export interface MLGWPaymentDTO {
  accountNumber: string;
  referenceNumber: string;
  status: string;
  amount: string;
  paidDate: string;
  paymentMethod: string;
  cardType: string;
  maskedCardNumber: string;
  cardLastFour: string;
  cardExpirationDate: string;
  nameOnCard: string;
  authorizationNumber: string;
  accountSelection: string;
  detailText: string;
  detailFetchedAt: Date | null;
}

/** Aggregate of a native bill download pass (Swift `MLGWDownloadResult`). */
export interface MLGWDownloadResult {
  downloadedBills: DownloadedBill[];
  documentStatuses: BillDocumentStatus[];
  payments: MLGWPaymentDTO[];
  downloadedDocuments: number;
  skippedKnownDocuments: number;
}

/** Result of a payments-only download pass (Swift `MLGWPaymentDownloadResult`). */
export interface MLGWPaymentDownloadResult {
  payments: MLGWPaymentDTO[];
  paymentTargets: number;
}

/** What `MLGWScriptCore.syncBills` returns before DTO mapping. */
export interface MLGWScriptSyncResult {
  summaries: BillJSONSummary[];
  documentStatuses: BillDocumentStatus[];
  payments: MLGWPaymentDTO[];
  downloadedDocuments: number;
  skippedKnownDocuments: number;
}

// MARK: - DB rows (migrations/20260711_resman_mlgw_sync.sql)
//
// The snake_case shapes the job layer upserts. Date columns are ISO `yyyy-MM-dd`
// strings (`string | null`); numeric columns are `number | null`. Audit columns
// with DB defaults (created_at/updated_at/synced_at/…) are optional.

/** `public.mlgw_accounts` (from MLGWAccount). PK `id`. */
export interface MlgwAccountRow {
  id: string;
  resman_property_id: string;
  property_name: string;
  account_number: string;
  service_address: string;
  resman_unit_id: string;
  unit_number: string;
  is_house_account: boolean;
  due_now: number | null;
  due_date: string | null;
  synced_at?: string;
}

/**
 * `public.mlgw_bills` (from MLGWBill). PK `id`; `document_key` defaults to `id`
 * when blank. Per-commodity columns (gas/electric/water/sewer) plus itemized fee
 * totals; the full parsed DTO + charges live in `raw` (jsonb).
 */
export interface MlgwBillRow {
  id: string;
  document_key: string;
  mlgw_account_id: string | null;
  resman_property_id: string;
  document_id: string;
  is_current: boolean;
  bill_date: string | null;
  due_date: string | null;
  amount_due: number | null;
  balance_forward: number | null;
  average_temperature: number | null;
  bill_for: string;
  file_path: string;
  gas_usage: string;
  gas_read_start_date: string | null;
  gas_read_end_date: string | null;
  gas_total: number | null;
  electric_usage: string;
  electric_read_start_date: string | null;
  electric_read_end_date: string | null;
  electric_total: number | null;
  water_usage: string;
  water_read_start_date: string | null;
  water_read_end_date: string | null;
  water_total: number | null;
  sewer_usage: string;
  sewer_read_start_date: string | null;
  sewer_read_end_date: string | null;
  sewer_total: number | null;
  other_mlgw_total: number | null;
  non_mlgw_total: number | null;
  street_light_fee_total: number | null;
  electrical_late_fee_total: number | null;
  security_deposit_total: number | null;
  smart_meter_connect_charge_total: number | null;
  credit_balance_transfer_total: number | null;
  share_the_pennies_total: number | null;
  water_cross_connection_fee_total: number | null;
  leasing_outdoor_lighting_total: number | null;
  mosquito_rodent_control_fee_total: number | null;
  sewer_charge_total: number | null;
  storm_water_fee_total: number | null;
  solid_waste_fee_total: number | null;
  raw: unknown;
  synced_at?: string;
}

/**
 * `public.mlgw_payments` (from MLGWPayment). PK `id` = `propertyId|payment|<digits>`.
 * NO card fields — they are intentionally not persisted (brief §"DROP ALL CARD FIELDS").
 */
export interface MlgwPaymentRow {
  id: string;
  mlgw_account_id: string | null;
  resman_property_id: string;
  account_number: string;
  reference_number: string;
  status: string;
  amount: number | null;
  paid_date: string | null;
  payment_method: string;
  authorization_number: string;
  account_selection: string;
  detail_fetched_at: string | null;
  detail_text: string;
}

/** `public.mlgw_exception_reviews`. PK `id` = `propertyId|billId|exceptionKind`. */
export interface MlgwExceptionReviewRow {
  id: string;
  resman_property_id: string;
  bill_id: string;
  account_number: string;
  exception_kind: string;
}

// ---- shared scraping types (cross-group: bill-list ↔ download) --------------

/**
 * The two MLGW bill collections. Port of the Swift `enum MLGWBillCollection`
 * (String-backed, CaseIterable). Modeled as an interface + const so it is usable
 * both as a type (`collection: MLGWBillCollection`) and a value
 * (`MLGWBillCollection.current`).
 */
export interface MLGWBillCollection {
  readonly rawValue: string;
  readonly isCurrent: boolean;
  readonly documentSetId: string;
  readonly displayName: string;
}
export const MLGWBillCollection = {
  current: { rawValue: "Current", isCurrent: true, documentSetId: "1", displayName: "Current Bills" },
  archived: { rawValue: "Archived", isCurrent: false, documentSetId: "2", displayName: "Archived Bills" },
} as const satisfies Record<string, MLGWBillCollection>;
/** All collections, in order (Swift `CaseIterable.allCases`). */
export const MLGW_BILL_COLLECTIONS: readonly MLGWBillCollection[] = [
  MLGWBillCollection.current,
  MLGWBillCollection.archived,
];

/** Per-bill account/service metadata scraped from a bill-list row. */
export interface BillRowMetadata {
  accountNumber: string | null;
  address: string | null;
  amountDue: string | null;
  dueDate: string | null;
}

/** A downloadable bill document target parsed from a bill-list page. */
export interface BillTarget {
  url: URL;
  method: string;
  fields: Record<string, string>;
  rowText: string;
  documentId: string | null;
  isCurrent: boolean;
  accountNumber: string | null;
  address: string | null;
  amountDue: string | null;
  dueDate: string | null;
  paymentListURL: URL | null;
}

/** Resolved document-context fields (sessionHandle/client) + action URL for a bill-list page. */
export interface BillListDocumentContext {
  fields: Record<string, string>;
  actionURL: URL;
  hasDocumentContext: boolean;
}

/** The billing-workspace session identifiers scraped from a loaded page. */
export interface BillingWorkspaceSession {
  serviceURL: URL;
  sessionHandle: string;
  client: string;
}

/** One deterministic list-page fetch unit (page index + start position + its target). */
export interface BillListPageWork {
  pageIndex: number;
  startPos: number;
  target: BillTarget;
}

/** The parsed result of one list page. */
export interface BillListPageResult {
  pageIndex: number;
  startPos: number;
  targets: BillTarget[];
}
