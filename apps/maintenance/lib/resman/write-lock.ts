/**
 * Per-key async mutex for the direct ResMan writes.
 *
 * A direct write is a read-modify-write cycle against a ~48-control form:
 * harvest the whole form, mutate an allowlist, POST every pair back, re-read
 * to verify. Two cycles for the SAME work order that overlap therefore both
 * harvest the same pre-write state, and the later POST — carrying the entire
 * form as it looked BEFORE the earlier write — silently reverts it. Field
 * case: the close flush and the edit flush are launched un-awaited off the
 * same sync tick, the close POSTs Status=Completed, and the edit's stale
 * payload puts Status back to "Not Started" while the app shows the ticket
 * closed and both entries acked.
 *
 * The guard belongs here rather than at the call sites because there is more
 * than one caller (the sync tick, the outbox screen's "Sync now"), and any
 * caller that forgets to await re-opens the hole. Keying by work order keeps
 * writes to DIFFERENT tickets fully concurrent — a tech closing out a day's
 * jobs still flushes in parallel.
 */

/** Tail of the queue per key: a promise that settles when the last holder is
 *  done. Never rejects (see below), so a failed write cannot poison the key. */
const tails = new Map<string, Promise<void>>();

/**
 * Run `task` with exclusive hold of `key`, queued behind anything already
 * holding it. The hold is released when the task settles — a throw releases
 * it exactly like a return, or one refused write would deadlock the ticket
 * for the life of the process.
 */
export function withKeyedLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(task);
  // The tail swallows the outcome: waiters queue behind COMPLETION, not
  // success, and an unhandled rejection must not escape from the chain.
  const tail = result.then(
    () => {},
    () => {},
  );
  tails.set(key, tail);
  void tail.then(() => {
    // Only the current tail may retire the key; a later waiter that already
    // replaced it keeps the queue alive.
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}
