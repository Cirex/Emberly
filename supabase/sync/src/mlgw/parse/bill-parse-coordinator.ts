/**
 * Port of KrakenCore/Services/MLGW/MLGWBillParseCoordinator.swift.
 *
 * Hands out bills to the parse workers and accumulates results, errors, and
 * profiling. The Swift class guarded its state with an `NSLock` for the detached
 * task group; JS is single-threaded and the awaited workers never interleave
 * mid-method, so the lock is dropped. Durations are milliseconds (`number`)
 * rather than `TimeInterval` seconds.
 */

import type { DownloadedBill, ParsedBill } from "../types";

export interface BillParseWork {
  index: number;
  bill: DownloadedBill;
}

export interface BillParseResults {
  parsed: ParsedBill[];
  errors: Array<[number, Error]>;
}

export interface BillParseProfileSummary {
  completed: number;
  totalDuration: number;
  averageDuration: number;
  slowestIndex: number | null;
  slowestDuration: number;
}

export class BillParseCoordinator {
  private readonly bills: DownloadedBill[];
  private readonly progress?: (message: string) => void;
  private nextIndex = 0;
  private completed = 0;
  private parsed: Array<[number, ParsedBill]> = [];
  private errors: Array<[number, Error]> = [];
  private lastProgressReport = Number.NEGATIVE_INFINITY;
  private totalDuration = 0;
  private slowestDuration = 0;
  private slowestIndex: number | null = null;

  constructor(bills: DownloadedBill[], progress?: (message: string) => void) {
    this.bills = bills;
    this.progress = progress;
  }

  nextBill(): BillParseWork | null {
    if (this.nextIndex >= this.bills.length) return null;
    const index = this.nextIndex;
    this.nextIndex += 1;
    return { index, bill: this.bills[index] };
  }

  recordSuccess(bill: ParsedBill, index: number, duration: number): void {
    this.record(index, duration, bill, null);
  }

  recordError(error: Error, index: number, duration: number): void {
    this.record(index, duration, null, error);
  }

  results(): BillParseResults {
    return {
      parsed: [...this.parsed].sort((a, b) => a[0] - b[0]).map(([, bill]) => bill),
      errors: [...this.errors].sort((a, b) => a[0] - b[0]),
    };
  }

  profileSummary(): BillParseProfileSummary {
    const averageDuration = this.completed > 0 ? this.totalDuration / this.completed : 0;
    return {
      completed: this.completed,
      totalDuration: this.totalDuration,
      averageDuration,
      slowestIndex: this.slowestIndex,
      slowestDuration: this.slowestDuration,
    };
  }

  private record(index: number, duration: number, bill: ParsedBill | null, error: Error | null): void {
    this.completed += 1;
    this.totalDuration += duration;
    if (duration > this.slowestDuration) {
      this.slowestDuration = duration;
      this.slowestIndex = index;
    }
    if (bill !== null) this.parsed.push([index, bill]);
    if (error !== null) this.errors.push([index, error]);

    const now = Date.now();
    const reportEvery = Math.max(1, Math.min(50, Math.floor(this.bills.length / 20)));
    const shouldReport =
      this.completed === 1 ||
      this.completed === this.bills.length ||
      this.completed % reportEvery === 0 ||
      now - this.lastProgressReport >= 750;
    if (!shouldReport) return;
    this.lastProgressReport = now;
    this.progress?.(`Parsed ${this.completed} of ${this.bills.length} bills`);
  }
}
