/**
 * MLGW payment-history scraping. Port of
 * KrakenCore/Services/MLGW/MLGWPaymentScraper.swift.
 *
 * From the bill targets, derive per-account "payment list" URLs, page through
 * each account's payment history, parse each payment summary, and enrich it with
 * the payment-detail page (method / card / authorization). Card fields are kept
 * on the in-memory DTO here; they are dropped when mapped to mlgw_payments.
 */
import { configuredHTTPTimeout, debugLog, readableErrorDescription } from "../env";
import {
  type MLGWHTTPClient,
  isCancellationError,
  mapWithConcurrency,
  withTransientNetworkRetries,
} from "../http";
import {
  attributes,
  cachedRegex,
  fastHTMLText,
  firstMatch,
  htmlLinks,
  nilIfBlank,
  queryFields,
  resolveURL,
  trimmedForCell,
  urlBySettingQueryFields,
} from "../text";
import type {
  BillTarget,
  HTTPResponse,
  MLGWPaymentDTO,
  MLGWScriptCancellation,
} from "../types";
import { backgroundSyncConcurrency } from "../download";
import { billingWorkspaceRefererURL } from "../download";
import { billListPageSize, deterministicBillListStartPositions, totalItemCount } from "../bill-list";

/** Mask an account number for logs — keep only the last 4 digits. */
function maskAccountNumber(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, "");
  return digits.length <= 4 ? "••••" : `••••${digits.slice(-4)}`;
}

export interface MLGWPaymentListTarget {
  url: URL;
  accountNumber: string;
  accountSelection: string;
}

export interface MLGWPaymentDetailFields {
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
  detailText: string;
  detailFetchedAt: Date;
}

// ---- small helpers ----------------------------------------------------------

const ONLY_DIGITS = /[^0-9]/g;
const digitsOnly = (value: string): string => value.replace(ONLY_DIGITS, "");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstValueCI(fields: Record<string, string>, requestedKey: string): string | null {
  const wanted = requestedKey.toLowerCase();
  for (const [key, value] of Object.entries(fields)) {
    if (key.toLowerCase() === wanted) return nilIfBlank(value);
  }
  return null;
}

function lastFourDigits(maskedCardNumber: string): string {
  return digitsOnly(maskedCardNumber).slice(-4);
}

// ---- payment-list target derivation ----------------------------------------

/** The account's "view payment summary" link inside a bill-list section. Port of `paymentListURL`. */
export function paymentListURL(sectionHTML: string, baseURL: URL): URL | null {
  for (const link of htmlLinks(sectionHTML, baseURL)) {
    const urlText = link.url.toString().toLowerCase();
    const label = fastHTMLText(link.text).toLowerCase().replace(/ /g, "");
    if (
      urlText.includes("payment-list-dialog") ||
      label.includes("viewpaymentsummary") ||
      label.includes("viewpayments")
    ) {
      return link.url;
    }
  }
  return null;
}

/** Reconstruct a payment-list URL from a bill target's session fields. Port of `inferredPaymentListURL`. */
export function inferredPaymentListURL(billTarget: BillTarget): URL | null {
  const fields: Record<string, string> = { ...queryFields(billTarget.url) };
  for (const [key, value] of Object.entries(billTarget.fields)) {
    if (value !== "") fields[key] = value;
  }

  const sessionHandle = firstValueCI(fields, "sessionHandle");
  const client = firstValueCI(fields, "client");
  if (sessionHandle === null || client === null) return null;

  const accountNumber = digitsOnly(firstValueCI(fields, "accountNumber") ?? billTarget.accountNumber ?? "");
  if (accountNumber === "") return null;

  const invoiceDueDate = firstValueCI(fields, "invoiceDueDate") ?? billTarget.dueDate ?? "";
  if (invoiceDueDate === "") return null;

  const selectedAccount = firstValueCI(fields, "selectedAccount") ?? firstValueCI(fields, "accountSelection") ?? "";
  const invoiceNumber = firstValueCI(fields, "invoiceNumber") ?? accountNumber;

  return urlBySettingQueryFields(billTarget.url, {
    sessionHandle,
    client,
    type: "WizardSearchService",
    action: "Payment-List-Dialog",
    retrieveLogicalPayments: "Y",
    operation: "search",
    startPos: "0",
    newBean: "true",
    pageOnly: "true",
    accountSelection: selectedAccount,
    documentId: "",
    invoiceNumber,
    invoiceLabel: "Bill",
    selectedAccount,
    accountNumber,
    invoiceDueDate,
  });
}

function paymentListDedupeKey(accountNumber: string, accountSelection: string, url: URL): string {
  const normalizedAccount = digitsOnly(accountNumber);
  const normalizedSelection = digitsOnly(accountSelection);
  if (normalizedSelection !== "") return `selection|${normalizedSelection}`;
  if (normalizedAccount !== "") return `account|${normalizedAccount}`;
  const fields = { ...queryFields(url) };
  delete fields["sessionHandle"];
  return Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("&");
}

function paymentReferenceDedupeKey(accountNumber: string, referenceNumber: string): string {
  return `${digitsOnly(accountNumber)}|${digitsOnly(referenceNumber)}`;
}

/** Unique per-account payment-list targets from the bill targets. Port of `uniquePaymentListTargets`. */
export function uniquePaymentListTargets(billTargets: BillTarget[]): MLGWPaymentListTarget[] {
  const seen = new Set<string>();
  const targets: MLGWPaymentListTarget[] = [];
  for (const billTarget of billTargets) {
    const url = billTarget.paymentListURL ?? inferredPaymentListURL(billTarget);
    if (url === null) continue;
    const query = queryFields(url);
    const fields: Record<string, string> = { ...billTarget.fields };
    for (const [key, value] of Object.entries(query)) {
      if (value !== "") fields[key] = value;
    }
    const selectedAccount = firstValueCI(fields, "selectedAccount");
    if (selectedAccount !== null) {
      fields["accountSelection"] = fields["accountSelection"] ?? selectedAccount;
    }
    const accountNumber = firstValueCI(fields, "accountNumber") ?? billTarget.accountNumber ?? "";
    const accountSelection =
      firstValueCI(fields, "accountSelection") ?? firstValueCI(fields, "selectedAccount") ?? "";
    const key = paymentListDedupeKey(accountNumber, accountSelection, url);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ url, accountNumber, accountSelection });
  }
  return targets;
}

// ---- payment collection -----------------------------------------------------

/** Read every account's payment history concurrently, deduped by reference. Port of `collectPayments`. */
export async function collectPayments(
  targets: MLGWPaymentListTarget[],
  client: MLGWHTTPClient,
  requestedWorkerCount: number,
  cancellation?: MLGWScriptCancellation,
  progress?: (message: string) => void,
): Promise<MLGWPaymentDTO[]> {
  if (targets.length === 0) return [];
  const workerCount = Math.min(backgroundSyncConcurrency(requestedWorkerCount), targets.length);
  progress?.(
    `MLGW payments: reading payment history for ${targets.length} account(s) with ${workerCount} worker(s)`,
  );

  const perTarget = await mapWithConcurrency(targets, workerCount, async (target) => {
    try {
      cancellation?.check();
      return await collectPaymentRecords(target, client.copyForConcurrentRequests(), cancellation);
    } catch (error) {
      if (isCancellationError(error)) return [];
      // Never log the full account number (it is PII / on the redaction list).
      // The always-on `progress` callback bypasses debugLog's redaction, and the
      // redaction regex only matches `accountNumber=` anyway — so mask here.
      const maskedAccount = maskAccountNumber(target.accountNumber);
      debugLog(
        `MLGW payments: skipped account ${maskedAccount} after payment list request failed: ${readableErrorDescription(error)}.`,
      );
      progress?.(`MLGW payments: skipped account ${maskedAccount} after the payment list request failed`);
      return [];
    }
  });

  cancellation?.check();
  const seenReferences = new Set<string>();
  const records: MLGWPaymentDTO[] = [];
  for (const targetRecords of perTarget) {
    for (const record of targetRecords) {
      const key = paymentReferenceDedupeKey(record.accountNumber, record.referenceNumber);
      if (seenReferences.has(key)) continue;
      seenReferences.add(key);
      records.push(record);
    }
  }
  return records;
}

/** Bounded concurrency for a single account's list-page and detail fetches. */
const PAYMENT_PAGE_CONCURRENCY = 4;
const PAYMENT_DETAIL_CONCURRENCY = 4;

async function collectPaymentRecords(
  target: MLGWPaymentListTarget,
  client: MLGWHTTPClient,
  cancellation?: MLGWScriptCancellation,
): Promise<MLGWPaymentDTO[]> {
  // Fetch page 1, then the remaining list pages in parallel (each on its own
  // client copy) instead of one at a time.
  const firstPage = await fetchPaymentListPage(target.url, client, cancellation);
  const restPageURLs = paymentListPageURLs(firstPage);
  const restPages = await mapWithConcurrency(
    restPageURLs,
    Math.min(PAYMENT_PAGE_CONCURRENCY, restPageURLs.length),
    async (pageURL) => {
      cancellation?.check();
      return fetchPaymentListPage(pageURL, client.copyForConcurrentRequests(), cancellation);
    },
  );

  // Flatten every record across all pages into one detail-fetch work list, so the
  // per-record detail fetches (the dominant cost) run through a single bounded
  // pool rather than serially per page.
  interface DetailWork {
    record: MLGWPaymentDTO;
    detailURL: URL | null;
  }
  const work: DetailWork[] = [];
  for (const page of [firstPage, ...restPages]) {
    const pageURL = new URL(page.url);
    for (const record of paymentRecords(page.text, pageURL, target)) {
      work.push({ record, detailURL: paymentDetailURL(record.referenceNumber, page.text, pageURL) });
    }
  }

  return mapWithConcurrency(
    work,
    Math.min(PAYMENT_DETAIL_CONCURRENCY, work.length),
    async ({ record, detailURL }) => {
      cancellation?.check();
      if (detailURL === null) return record;
      const detail = await fetchPaymentDetail(detailURL, client.copyForConcurrentRequests(), cancellation);
      return enrichedPayment(record, paymentDetailFields(detail.text));
    },
  );
}

async function fetchPaymentListPage(
  url: URL,
  client: MLGWHTTPClient,
  cancellation?: MLGWScriptCancellation,
): Promise<HTTPResponse> {
  return withTransientNetworkRetries(
    () =>
      client.request("GET", url, {
        headers: {
          Accept: "text/html, */*; q=0.01",
          Referer: billingWorkspaceRefererURL(url)?.toString() ?? url.toString(),
          "X-Requested-With": "XMLHttpRequest",
        },
        timeoutMs: configuredHTTPTimeout("MLGW_PAYMENT_LIST_REQUEST_TIMEOUT", 45_000),
      }),
    { maxAttempts: 3, cancellation, debugLabel: `MLGW payment list ${queryFields(url)["startPos"] ?? "0"}` },
  );
}

async function fetchPaymentDetail(
  url: URL,
  client: MLGWHTTPClient,
  cancellation?: MLGWScriptCancellation,
): Promise<HTTPResponse> {
  return withTransientNetworkRetries(
    () =>
      client.request("GET", url, {
        headers: {
          Accept: "text/html, */*; q=0.01",
          Referer: billingWorkspaceRefererURL(url)?.toString() ?? url.toString(),
          "X-Requested-With": "XMLHttpRequest",
        },
        timeoutMs: configuredHTTPTimeout("MLGW_PAYMENT_DETAIL_REQUEST_TIMEOUT", 45_000),
      }),
    {
      maxAttempts: 3,
      cancellation,
      debugLabel: `MLGW payment detail ${queryFields(url)["referenceNumber"] ?? ""}`,
    },
  );
}

// ---- parsing ----------------------------------------------------------------

/** Parse the payment-summary rows on a payment-list page. Port of `paymentRecords`. */
export function paymentRecords(html: string, baseURL: URL, target: MLGWPaymentListTarget): MLGWPaymentDTO[] {
  const pattern =
    "<div\\b([^>]*\\bdata-url\\s*=\\s*(?:\"[^\"]*SelectPayment[^\"]*\"|'[^']*SelectPayment[^']*')[^>]*)>.*?<div\\b[^>]*class\\s*=\\s*(?:\"[^\"]*label_text[^\"]*accordion_header[^\"]*\"|'[^']*label_text[^']*accordion_header[^']*')[^>]*>(.*?)</div>";
  const regex = cachedRegex(pattern, "gis");
  const records: MLGWPaymentDTO[] = [];
  for (const match of html.matchAll(regex)) {
    const attrText = match[1];
    const labelHTML = match[2];
    if (attrText === undefined || labelHTML === undefined) continue;
    const attrs = attributes(attrText);
    const dataURL = attrs["data-url"] !== undefined ? resolveURL(attrs["data-url"], baseURL) : null;
    const label = fastHTMLText(labelHTML);
    const fallbackReference = dataURL !== null ? (queryFields(dataURL)["referenceNumber"] ?? null) : null;
    const parsed = parsedPaymentSummary(label, fallbackReference);
    if (parsed === null) continue;
    records.push({
      accountNumber: target.accountNumber,
      referenceNumber: parsed.referenceNumber,
      status: parsed.status,
      amount: parsed.amount,
      paidDate: parsed.paidDate,
      paymentMethod: "",
      cardType: "",
      maskedCardNumber: "",
      cardLastFour: "",
      cardExpirationDate: "",
      nameOnCard: "",
      authorizationNumber: "",
      accountSelection: target.accountSelection,
      detailText: "",
      detailFetchedAt: null,
    });
  }
  return records;
}

/** The next-page URLs after the first payment-list page. Port of `paymentListPageURLs`. */
export function paymentListPageURLs(firstPage: HTTPResponse): URL[] {
  const pageSize = billListPageSize(firstPage);
  const starts = deterministicBillListStartPositions(totalItemCount(firstPage.text), pageSize);
  return starts.slice(1).map((startPosition) =>
    urlBySettingQueryFields(new URL(firstPage.url), {
      pageOnly: "true",
      operation: "next",
      startPos: String(startPosition),
      pageSize: String(pageSize),
    }),
  );
}

/** The `SelectPayment` detail URL for a reference number. Port of `paymentDetailURL`. */
export function paymentDetailURL(referenceNumber: string, html: string, baseURL: URL): URL | null {
  for (const link of htmlLinks(html, baseURL)) {
    const fields = queryFields(link.url);
    if (
      (fields["action"] ?? "").toLowerCase() === "selectpayment" &&
      fields["referenceNumber"] === referenceNumber
    ) {
      return link.url;
    }
  }
  const escaped = escapeRegExp(referenceNumber);
  const pattern = `<div\\b([^>]*\\bdata-url\\s*=\\s*(?:"[^"]*referenceNumber=${escaped}[^"]*"|'[^']*referenceNumber=${escaped}[^']*')[^>]*)`;
  const regex = cachedRegex(pattern, "is");
  const match = regex.exec(html);
  if (match === null || match[1] === undefined) return null;
  const dataURL = attributes(match[1])["data-url"];
  return dataURL !== undefined ? resolveURL(dataURL, baseURL) : null;
}

interface ParsedPaymentSummary {
  referenceNumber: string;
  status: string;
  amount: string;
  paidDate: string;
}

function parsedPaymentSummary(text: string, fallbackReferenceNumber: string | null): ParsedPaymentSummary | null {
  const regex = cachedRegex(
    "\\bPayment\\s+([0-9]+)\\.\\s*([A-Za-z ]+?)\\s+\\$?([0-9,]+\\.[0-9]{2})\\s+on\\s+([0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4})\\b",
    "i",
  );
  const match = regex.exec(text);
  if (match === null) {
    if (fallbackReferenceNumber === null) return null;
    return { referenceNumber: fallbackReferenceNumber, status: "", amount: "", paidDate: "" };
  }
  const group = (index: number): string => trimmedForCell(match[index] ?? "");
  return { referenceNumber: group(1), status: group(2), amount: group(3), paidDate: group(4) };
}

const PAYMENT_NEXT_LABELS = [
  "Reference ID", "Status", "Submitted by", "Customer", "Creation date", "Payment Information",
  "Account number", "Issue Date", "Customer type", "Payment Date", "Paid Date",
  "Payment Amount", "Amount", "Method of Payment", "Payment Method", "Method",
  "Bank account type", "Account holder name", "Routing number", "Bank name",
  "Card Type", "Credit Card Type", "Card Number", "Card #", "Credit Card Number",
  "Expiration date", "Authorization Number", "Authorization #", "Auth Number",
  "Auth Code", "Name on card", "Cardholder Name", "Confirmation Number", "Confirmation #",
  "Posted Date", "Post Date", "Contact and Card Billing Information",
  "Contact Information", "Card Billing Information", "First name", "Business name",
];

function paymentDetailValue(text: string, labels: string[]): string {
  for (const label of labels) {
    const escapedLabel = escapeRegExp(label);
    const escapedNextLabels = PAYMENT_NEXT_LABELS.filter(
      (candidate) => candidate.toLowerCase() !== label.toLowerCase(),
    )
      .map(escapeRegExp)
      .join("|");
    const pattern = `\\b${escapedLabel}\\b\\s*:?\\s*(.+?)(?=\\s+(?:${escapedNextLabels})\\b|$)`;
    const value = firstMatch(text, pattern);
    if (value !== null) return trimmedForCell(value);
  }
  return "";
}

function maskedPaymentCardNumber(value: string): string {
  const trimmed = trimmedForCell(value);
  if (trimmed === "") return "";
  const digits = digitsOnly(trimmed);
  if (digits.length <= 4 || trimmed.includes("*") || trimmed.toLowerCase().includes("x")) return trimmed;
  return `**** **** **** ${digits.slice(-4)}`;
}

function normalizedPaymentMethod(value: string): string {
  const trimmed = trimmedForCell(value);
  if (trimmed === "") return "";
  return trimmed.toLowerCase().includes("card") ? "Card" : trimmed;
}

/** Parse the payment-detail page into method/card/authorization fields. Port of `paymentDetailFields`. */
export function paymentDetailFields(html: string): MLGWPaymentDetailFields {
  const text = fastHTMLText(html);
  const maskedCard = maskedPaymentCardNumber(
    paymentDetailValue(text, ["Card Number", "Card #", "Credit Card Number"]),
  );
  return {
    status: paymentDetailValue(text, ["Status"]),
    amount: paymentDetailValue(text, ["Payment Amount", "Amount"]),
    paidDate: paymentDetailValue(text, ["Payment Date", "Paid Date"]),
    paymentMethod: normalizedPaymentMethod(
      paymentDetailValue(text, ["Method of Payment", "Payment Method", "Method"]),
    ),
    cardType: paymentDetailValue(text, ["Card Type", "Credit Card Type"]),
    maskedCardNumber: maskedCard,
    cardLastFour: lastFourDigits(maskedCard),
    cardExpirationDate: paymentDetailValue(text, ["Expiration Date", "Expiration"]),
    nameOnCard: paymentDetailValue(text, ["Name on Card", "Cardholder Name"]),
    authorizationNumber: paymentDetailValue(text, [
      "Authorization Number",
      "Authorization #",
      "Auth Number",
      "Auth Code",
    ]),
    detailText: text,
    detailFetchedAt: new Date(),
  };
}

function enrichedPayment(record: MLGWPaymentDTO, fields: MLGWPaymentDetailFields): MLGWPaymentDTO {
  return {
    accountNumber: record.accountNumber,
    referenceNumber: record.referenceNumber,
    status: nilIfBlank(record.status) ?? fields.status,
    amount: nilIfBlank(record.amount) ?? fields.amount,
    paidDate: nilIfBlank(record.paidDate) ?? fields.paidDate,
    paymentMethod: fields.paymentMethod,
    cardType: fields.cardType,
    maskedCardNumber: fields.maskedCardNumber,
    cardLastFour: fields.cardLastFour,
    cardExpirationDate: fields.cardExpirationDate,
    nameOnCard: fields.nameOnCard,
    authorizationNumber: fields.authorizationNumber,
    accountSelection: record.accountSelection,
    detailText: fields.detailText,
    detailFetchedAt: fields.detailFetchedAt,
  };
}
