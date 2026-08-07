/**
 * A cross-process lock so two scrapers never hit the same portal at once.
 *
 * WHY. Every portal client builds its own `RequestScheduler`, and that
 * semaphore is per PROCESS. Two runners therefore do not share a ceiling: with
 * `connectionsPerHost` at 6 — which the design flags as the safe maximum,
 * because past it "ResMan returns HTML error pages instead of data" — two
 * concurrent runners make 12 in-flight requests and the scrape starts
 * succeeding with unparseable HTML.
 *
 * That is not hypothetical. A `sync-deep-scrape` chain was observed running
 * against a previous chain's `run-lease-details`, and the older one died at
 * 588 of 750 leases without writing anything, because `syncLeaseDetails`
 * accumulates the whole sweep in memory and upserts once at the end. An
 * interrupted deep scrape loses everything it did.
 *
 * THE LOCK IS PER PORTAL, NOT PER RUNNER. A per-runner lock would have allowed
 * exactly the collision that happened, since `run-unit-details` and
 * `run-lease-details` are different runners contending for the same ResMan
 * ceiling. `sync-core` on an hourly cron overlapping the hour-long deep scrape
 * is the same problem and is likewise covered.
 *
 * SKIPPING IS NORMAL, NOT A FAILURE. A scheduled job that finds the lock held
 * logs why and exits 0: it will run again on the next tick, and a red task for
 * "the previous run had not finished" trains people to ignore red tasks. The
 * log line names the holder, its pid and its age, so a genuinely stuck lock is
 * still obvious.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Contended resources. One lock per external portal. */
export type LockName = "resman" | "mlgw";

export interface LockRecord {
  pid: number;
  job: string;
  startedAt: string;
}

export interface AcquiredLock {
  /** Release the lock. Safe to call more than once. */
  release(): void;
}

/**
 * Where locks live. `/tmp` inside the container is shared by every scheduled
 * task, because Coolify `exec`s them into the SAME container — which is what
 * makes a file lock work here at all.
 */
export function lockDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SYNC_LOCK_DIR?.trim() || path.join(os.tmpdir(), "emberly-sync-locks");
}

function lockPath(name: LockName, env?: NodeJS.ProcessEnv): string {
  return path.join(lockDir(env), `${name}.lock`);
}

/**
 * Is this pid still running?
 *
 * `kill(pid, 0)` sends no signal and only tests existence/permission. EPERM
 * means the process exists but belongs to someone else — still alive, so the
 * lock is still held.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(file: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as LockRecord;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    // Unreadable or truncated — a crash mid-write. Treat as no lock rather than
    // wedging every future run on a corrupt file.
    return null;
  }
}

export function describeAge(startedAt: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export interface AcquireResult {
  ok: boolean;
  lock?: AcquiredLock;
  /** Set when `ok` is false — the run that already holds it. */
  heldBy?: LockRecord;
}

/**
 * Take `name` for `job`, or report who holds it.
 *
 * A lock whose pid is gone is STALE and gets taken over: a container restart or
 * a `kill -9` would otherwise leave a file that blocks every future run with no
 * way to notice but reading /tmp.
 */
export function acquireLock(
  name: LockName,
  job: string,
  env: NodeJS.ProcessEnv = process.env,
): AcquireResult {
  const dir = lockDir(env);
  mkdirSync(dir, { recursive: true });
  const file = lockPath(name, env);

  const existing = existsSync(file) ? readLock(file) : null;
  if (existing && isProcessAlive(existing.pid)) {
    return { ok: false, heldBy: existing };
  }

  const record: LockRecord = { pid: process.pid, job, startedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(record), "utf8");

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      // Only remove OUR record. Between a stale takeover and here, another run
      // may legitimately own the file; deleting it would hand the portal to a
      // third process while the second is still scraping.
      const current = readLock(file);
      if (current?.pid === process.pid) unlinkSync(file);
    } catch {
      /* best effort — a missing lock file is the desired end state anyway */
    }
  };

  return { ok: true, lock: { release } };
}

/**
 * Run `fn` while holding the portal lock, or skip.
 *
 * Returns the runner's exit code: 0 when the work ran, and 0 when it was
 * skipped — see the header on why skipping is not a failure. Release is wired
 * to normal return, throw, and SIGINT/SIGTERM, because Coolify's task timeout
 * terminates rather than letting the process finish.
 */
export async function withLock(
  name: LockName,
  job: string,
  fn: () => Promise<void>,
  opts: { log?: (message: string) => void; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const result = acquireLock(name, job, opts.env);

  if (!result.ok) {
    const held = result.heldBy!;
    log(
      `[${job}] SKIPPED — "${held.job}" is already using ${name} ` +
        `(pid ${held.pid}, running ${describeAge(held.startedAt)}). ` +
        `Two scrapers would double the request ceiling; this will run on the next tick.`,
    );
    return 0;
  }

  const release = result.lock!.release;
  const onSignal = (): never => {
    release();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await fn();
    return 0;
  } finally {
    release();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
