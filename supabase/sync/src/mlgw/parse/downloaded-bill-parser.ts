/**
 * Port of KrakenCore/Services/MLGW/MLGWDownloadedBillParser.swift.
 *
 * Parses a batch of `DownloadedBill`s into `ParsedBill`s with bounded
 * concurrency (brief §6) — the TS analog of the Swift detached-task group over
 * `BillParseCoordinator`. It is pure (each `parseBill` is pure) and disk-free.
 * `uniqueParsedBills` dedupes by document id (or an account/date/amount key),
 * preferring the un-suffixed filename when two bills collide.
 *
 * `parseMLGWDate`-adjacent helpers (`backgroundParseConcurrency`,
 * `checkMLGWProcessingCancellation`, `digitsOnly`) live in the download group
 * and are imported from `../download`. `logProfileDuration` (Swift env) is a
 * thin local wrapper over `../env.profileLog`.
 */

import type { DownloadedBill, MLGWScriptCancellation, ParsedBill } from "../types";
import { ScriptError } from "../types";
import {
  debugLog,
  formattedDuration,
  formattedProfileRate,
  profileLog,
  readableErrorDescription,
} from "../env";
import { backgroundParseConcurrency, checkMLGWProcessingCancellation, digitsOnly } from "../download";
import { BillParseCoordinator } from "./bill-parse-coordinator";
import { parseBill } from "./bill-parser";

export interface ParseDownloadedBillsOptions {
  requestedWorkerCount?: number;
  cancellation?: MLGWScriptCancellation;
  progress?: (message: string) => void;
}

/** Faithful port of `parseDownloadedBills(_:requestedWorkerCount:cancellation:progress:)`. */
export async function parseDownloadedBills(
  bills: DownloadedBill[],
  options: ParseDownloadedBillsOptions = {},
): Promise<ParsedBill[]> {
  if (bills.length === 0) return [];
  const { requestedWorkerCount, cancellation, progress } = options;
  checkMLGWProcessingCancellation(cancellation);

  const workerCount = Math.min(backgroundParseConcurrency(requestedWorkerCount), bills.length);
  progress?.(
    `Parsing ${bills.length} downloaded bill${bills.length === 1 ? "" : "s"} with ${workerCount} worker${workerCount === 1 ? "" : "s"}`,
  );
  debugLog(`Parsing ${bills.length} downloaded bill file(s) with ${workerCount} worker(s).`);
  profileLog(`Bill parse setup | bills=${bills.length} workers=${workerCount}`);

  const coordinator = new BillParseCoordinator(bills, progress);
  const parseProfileStartedAt = Date.now();

  const worker = async (): Promise<void> => {
    let work = coordinator.nextBill();
    while (work !== null) {
      const billStartedAt = Date.now();
      checkMLGWProcessingCancellation(cancellation);
      try {
        const parsed = parseBill(work.bill);
        coordinator.recordSuccess(parsed, work.index, Date.now() - billStartedAt);
      } catch (error) {
        coordinator.recordError(toError(error), work.index, Date.now() - billStartedAt);
      }
      checkMLGWProcessingCancellation(cancellation);
      work = coordinator.nextBill();
    }
  };

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i += 1) workers.push(worker());
  await Promise.all(workers);
  checkMLGWProcessingCancellation(cancellation);

  const results = coordinator.results();
  if (results.errors.length > 0) {
    // The download layer deliberately tolerates per-bill failures (it only
    // throws when NOTHING downloaded). The parse layer must do the same: a
    // single unparseable bill (PDF-only, malformed HTML) should not discard
    // every bill that parsed cleanly. Log each failure and continue; only a
    // total wipeout — nothing parsed at all — aborts the run.
    for (const [index, error] of results.errors) {
      progress?.(
        `MLGW bills: skipped bill ${index + 1} of ${bills.length}: ${readableErrorDescription(error)}`,
      );
    }
    if (results.parsed.length === 0) {
      throw ScriptError.badResponse(
        `All ${bills.length} downloaded bills failed to parse; first error: ${readableErrorDescription(results.errors[0][1])}`,
      );
    }
  }

  const summary = coordinator.profileSummary();
  const wallElapsed = logProfileDuration(
    "Bill parse wall time",
    parseProfileStartedAt,
    `processed=${summary.completed} parsed=${results.parsed.length} errors=${results.errors.length} workers=${workerCount}`,
  );
  const slowest = summary.slowestIndex === null ? "none" : `#${summary.slowestIndex + 1}`;
  profileLog(
    `Bill parse worker profile | totalWorkerTime=${formattedDuration(summary.totalDuration)} average=${formattedDuration(summary.averageDuration)} slowest=${slowest} ${formattedDuration(summary.slowestDuration)} wallRate=${formattedProfileRate(summary.completed, wallElapsed)}`,
  );
  progress?.(
    `Parsed ${results.parsed.length} downloaded bill${results.parsed.length === 1 ? "" : "s"}`,
  );
  return results.parsed;
}

/** Faithful port of `uniqueParsedBills(_:)`. */
export function uniqueParsedBills(bills: ParsedBill[]): ParsedBill[] {
  const bestByKey = new Map<string, ParsedBill>();
  const suffixedName = /-[0-9]+\.(?:pdf|html|htm)$/i;

  for (const bill of bills) {
    const documentId = bill.documentId.trim();
    const key =
      documentId.length === 0
        ? [
            digitsOnly(bill.accountNumber),
            bill.billDate,
            bill.dueDate,
            String(bill.amountDue ?? 0),
          ].join("|")
        : `document|${documentId}`;

    const existing = bestByKey.get(key);
    if (existing === undefined) {
      bestByKey.set(key, bill);
      continue;
    }

    const billName = lastPathComponent(bill.filePath);
    const existingName = lastPathComponent(existing.filePath);
    const billIsSuffixed = suffixedName.test(billName);
    const existingIsSuffixed = suffixedName.test(existingName);
    if (existingIsSuffixed && !billIsSuffixed) {
      bestByKey.set(key, bill);
    }
  }

  return [...bestByKey.values()].sort((a, b) => {
    if (a.billDate !== b.billDate) return a.billDate < b.billDate ? -1 : 1;
    const accountA = digitsOnly(a.accountNumber);
    const accountB = digitsOnly(b.accountNumber);
    if (accountA === accountB) return 0;
    return accountA < accountB ? -1 : 1;
  });
}

function lastPathComponent(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Local wrapper for Swift `logProfileDuration` (not exported by `env.ts`). */
function logProfileDuration(stage: string, startedAtMs: number, metadata = ""): number {
  const elapsed = Date.now() - startedAtMs;
  const suffix = metadata.length === 0 ? "" : ` | ${metadata}`;
  profileLog(`${stage} ${formattedDuration(elapsed)}${suffix}`);
  return elapsed;
}
