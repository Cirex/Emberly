/**
 * ResMan request scheduler — thin alias over the shared `RequestScheduler`
 * (../shared/request-scheduler), the generic FIFO concurrency semaphore now
 * shared with the MLGW client. Design §3.1.
 *
 * Kept as a named re-export so the ResMan client and its tests keep referring to
 * `ResManRequestScheduler`.
 */

export {
  RequestScheduler as ResManRequestScheduler,
  type RequestSchedulerSnapshot,
} from "../shared/request-scheduler";
