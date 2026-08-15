/**
 * The in-memory half of the rate limiters, with an actual eviction policy.
 *
 * Both callers (`lib/rate-limit.ts` and `lib/scanner-auth.ts`) used to hold a
 * bare `Map<string, RateLimitEntry>` that was written on every attempt and
 * never read from again once its window lapsed. Nothing deleted from either.
 *
 * That is fine when the key space is small, and a leak when it is not. The
 * scanner limiter keys on `${scannerId}:${type}:${token.slice(-24)}`, and
 * resident entry tokens are minted with a 60-SECOND ttl — so the tail is
 * effectively unique per scan and every gate scan added a permanent entry. At
 * ~300 bytes each, a gate doing 2k scans/day accretes ~250MB/year, and a V8
 * Map never returns its backing store. That is a slow OOM on the container,
 * presenting as "the web server's memory climbs until it restarts".
 *
 * The durable half of the same limiter (the `rate_limits` table) has always
 * been pruned by `runAppDataCleanup`. This is the missing other half.
 *
 * Sweeping is amortized, not per-request: a full pass runs at most once per
 * SWEEP_INTERVAL_MS, or immediately whenever the map is over its cap. Because
 * every entry carries a `resetAt` and the windows are short (60s), a sweep
 * normally empties almost the whole map in one pass.
 */

export interface MemoryRateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Ceiling on LIVE (unexpired) entries. Well above any legitimate working set —
 * at a 60s window this is 10k distinct keys inside one minute — so reaching it
 * means a flood rather than real traffic.
 */
const DEFAULT_MAX_ENTRIES = 10_000;

/** How often a full expiry pass may run, absent cap pressure. */
const SWEEP_INTERVAL_MS = 60_000;

export class MemoryRateLimiter {
  private readonly entries = new Map<string, MemoryRateLimitEntry>();
  private readonly maxEntries: number;
  private nextSweepAt = 0;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  /**
   * Records an attempt against `key`. True when it is within the allowance.
   * Semantics are unchanged from the two implementations this replaces: the
   * first attempt in a window opens a new one, and the check is inclusive of
   * `maxAttempts`.
   */
  check(key: string, maxAttempts: number, windowMs: number, now: number = Date.now()): boolean {
    this.sweep(now);

    const existing = this.entries.get(key);
    if (!existing || now > existing.resetAt) {
      this.entries.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    existing.count += 1;
    return existing.count <= maxAttempts;
  }

  /** Live entry count. Exposed so the eviction policy is testable. */
  get size(): number {
    return this.entries.size;
  }

  /** Test seam — no production caller resets a limiter mid-process. */
  clear(): void {
    this.entries.clear();
    this.nextSweepAt = 0;
  }

  private sweep(now: number): void {
    if (now < this.nextSweepAt && this.entries.size < this.maxEntries) return;
    this.nextSweepAt = now + SWEEP_INTERVAL_MS;

    // Deleting during Map iteration is well-defined: an entry removed before
    // the cursor reaches it is simply not visited.
    for (const [key, entry] of this.entries) {
      if (now > entry.resetAt) this.entries.delete(key);
    }

    // Leave room for the insert this sweep is running ahead of, so `size`
    // never exceeds maxEntries once check() returns.
    const target = this.maxEntries - 1;
    if (this.entries.size <= target) return;

    // Still over the cap with nothing expired — every entry is inside its
    // window, which only happens under a flood. Evict oldest-first (Map
    // preserves insertion order) so a bounded map is never the thing that
    // takes the process down.
    //
    // Evicting a live entry does reset that key's counter. Accepted: the
    // callers run the DURABLE limiter first (`checkRateLimit`, failClosed on
    // the scanner path), so this layer is a fast local backstop, not the gate.
    const excess = this.entries.size - target;
    let dropped = 0;
    for (const key of this.entries.keys()) {
      if (dropped >= excess) break;
      this.entries.delete(key);
      dropped += 1;
    }
  }
}
