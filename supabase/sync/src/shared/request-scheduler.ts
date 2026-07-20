/**
 * RequestScheduler — a small FIFO counting semaphore that bounds the number of
 * concurrent operations (HTTP requests) allowed to run at once.
 *
 * Every request from a portal client passes through `withPermit`, which caps
 * total in-flight requests at `maximumConcurrentRequests` regardless of how many
 * item-level worker pools are nested above it. Waiters queue FIFO and resume in
 * order as permits free. This is the politeness / rate-limit choke point the
 * scraped portals need: raising concurrency past the safe ceiling makes them
 * serve HTML error pages instead of data (ResMan design §8), and the same guard
 * protects the MLGW portal. Hand-rolled (no `p-limit` dependency) to keep the
 * FIFO + release-on-throw semantics identical to the Swift source and directly
 * unit-testable.
 *
 * Originally the ResMan-specific `ResManRequestScheduler`; generalized here so
 * both the ResMan and MLGW clients share one implementation.
 */

export interface RequestSchedulerSnapshot {
  maximumConcurrentRequests: number;
  activeRequests: number;
  queuedRequests: number;
  highWaterMark: number;
  completedRequests: number;
}

interface Waiter {
  resume: (granted: boolean) => void;
}

export class RequestScheduler {
  private maximumConcurrentRequests: number;
  private activeRequests = 0;
  private readonly queuedWaiters: Waiter[] = [];
  private highWaterMark = 0;
  private completedRequests = 0;
  /** Once a caller's `withPermit({limit})` has set the pool size, later limits
   *  are ignored so a shared scheduler keeps a stable ceiling. */
  private limitLatched = false;

  constructor(maximumConcurrentRequests: number) {
    this.maximumConcurrentRequests = Math.max(1, maximumConcurrentRequests);
  }

  /**
   * Run `operation` while holding a permit. Acquires (queuing if the pool is
   * full), runs, then releases the slot — even if `operation` throws — before
   * rethrowing. When `limit` is provided it resizes the pool, matching the Swift
   * `withPermit(label:limit:)` overload the ResMan client uses to apply
   * `connectionsPerHost` per call.
   */
  async withPermit<T>(
    operation: () => Promise<T>,
    options: { label?: string; limit?: number } = {},
  ): Promise<T> {
    // Latch the pool size to the FIRST caller's limit. Re-applying it on every
    // request is wasteful, and when this scheduler is shared across clients with
    // different `connectionsPerHost` it made the effective ceiling "whoever
    // called last" — undermining the politeness limit the scheduler exists to
    // enforce.
    if (options.limit !== undefined && !this.limitLatched) {
      this.setMaximumConcurrentRequests(options.limit);
      this.limitLatched = true;
    }
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  setMaximumConcurrentRequests(value: number): void {
    this.maximumConcurrentRequests = Math.max(1, value);
    this.drainWaiters();
  }

  snapshot(): RequestSchedulerSnapshot {
    return {
      maximumConcurrentRequests: this.maximumConcurrentRequests,
      activeRequests: this.activeRequests,
      queuedRequests: this.queuedWaiters.length,
      highWaterMark: this.highWaterMark,
      completedRequests: this.completedRequests,
    };
  }

  private acquire(): Promise<void> {
    if (this.activeRequests < this.maximumConcurrentRequests) {
      this.activeRequests += 1;
      this.highWaterMark = Math.max(this.highWaterMark, this.activeRequests);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queuedWaiters.push({ resume: () => resolve() });
    });
  }

  private release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.completedRequests += 1;
    this.drainWaiters();
  }

  private drainWaiters(): void {
    while (this.activeRequests < this.maximumConcurrentRequests && this.queuedWaiters.length > 0) {
      const waiter = this.queuedWaiters.shift()!;
      this.activeRequests += 1;
      this.highWaterMark = Math.max(this.highWaterMark, this.activeRequests);
      waiter.resume(true);
    }
  }
}
