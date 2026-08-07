const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { acquireLock, withLock, isProcessAlive, describeAge, lockDir } =
  require("../src/shared/run-lock.ts");

/** A throwaway lock directory per test, so nothing leaks between them. */
function tmpEnv() {
  return { SYNC_LOCK_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "run-lock-test-")) };
}

test("a second run is refused while the first holds the portal", () => {
  const env = tmpEnv();
  const first = acquireLock("resman", "run-unit-details", env);
  assert.equal(first.ok, true);

  const second = acquireLock("resman", "run-units", env);
  assert.equal(second.ok, false, "the second run must not get the lock");
  assert.equal(second.heldBy.job, "run-unit-details", "and must be told who holds it");
  assert.equal(second.heldBy.pid, process.pid);

  first.lock.release();
  assert.equal(acquireLock("resman", "run-units", env).ok, true, "released means available");
});

test("the two portals do not block each other", () => {
  // A ResMan scrape and an MLGW scrape hit different hosts with different
  // ceilings; serialising them would halve throughput for no benefit.
  const env = tmpEnv();
  assert.equal(acquireLock("resman", "run-units", env).ok, true);
  assert.equal(acquireLock("mlgw", "run-mlgw-bills", env).ok, true);
});

test("a lock left by a DEAD process is taken over, not honoured forever", () => {
  // A container restart or `kill -9` leaves the file behind. Without stale
  // takeover every future run would skip, and the only symptom would be a
  // scheduled task that silently does nothing.
  const env = tmpEnv();
  const file = path.join(env.SYNC_LOCK_DIR, "resman.lock");
  fs.mkdirSync(env.SYNC_LOCK_DIR, { recursive: true });
  // pid 2^22 is above Linux's default pid_max and cannot be running.
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: 4194304, job: "run-lease-details", startedAt: new Date().toISOString() }),
  );

  const result = acquireLock("resman", "run-units", env);
  assert.equal(result.ok, true, "a dead holder must not block the portal");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
});

test("a corrupt lock file does not wedge every future run", () => {
  const env = tmpEnv();
  fs.mkdirSync(env.SYNC_LOCK_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.SYNC_LOCK_DIR, "resman.lock"), "{ truncated mid-writ");
  assert.equal(acquireLock("resman", "run-units", env).ok, true);
});

test("release only removes OUR record, never someone else's", () => {
  // Between a stale takeover and release, another run can legitimately own the
  // file. Deleting it blindly would hand the portal to a third process while
  // the second is still scraping.
  const env = tmpEnv();
  const first = acquireLock("resman", "run-units", env);
  const file = path.join(env.SYNC_LOCK_DIR, "resman.lock");
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: process.pid + 1, job: "someone-else", startedAt: new Date().toISOString() }),
  );
  first.lock.release();
  assert.equal(fs.existsSync(file), true, "another run's lock must survive our release");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).job, "someone-else");
});

test("withLock runs the job, releases after, and reports success", async () => {
  const env = tmpEnv();
  let ran = 0;
  const code = await withLock("resman", "run-units", async () => { ran += 1; }, { env, log: () => {} });
  assert.equal(code, 0);
  assert.equal(ran, 1);
  assert.equal(acquireLock("resman", "other", env).ok, true, "released on the way out");
});

test("withLock releases even when the job throws, and rethrows", async () => {
  const env = tmpEnv();
  await assert.rejects(
    withLock("resman", "run-units", async () => { throw new Error("scrape blew up"); }, { env, log: () => {} }),
    /scrape blew up/,
  );
  assert.equal(acquireLock("resman", "other", env).ok, true, "a crash must not strand the lock");
});

test("a skipped run exits 0 and names the holder, its pid and its age", async () => {
  // Skipping is normal operation, not a failure: the job runs again next tick.
  // A red task for "the previous run had not finished" teaches people to ignore
  // red tasks — but the line must still identify a genuinely stuck holder.
  const env = tmpEnv();
  acquireLock("resman", "run-lease-details", env);

  const lines = [];
  let ran = 0;
  const code = await withLock("resman", "run-units", async () => { ran += 1; },
    { env, log: (m) => lines.push(m) });

  assert.equal(code, 0, "a skip is exit 0");
  assert.equal(ran, 0, "and the work must not run");
  const message = lines.join("\n");
  assert.match(message, /SKIPPED/);
  assert.match(message, /run-lease-details/, "names the holder");
  assert.match(message, new RegExp(`pid ${process.pid}`), "names the pid");
  assert.match(message, /running \d+[mh]/, "names the age");
});

test("isProcessAlive: this process yes, absurd pid no", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(4194304), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});

test("describeAge renders minutes then hours", () => {
  const now = new Date("2026-08-07T12:00:00Z");
  assert.equal(describeAge("2026-08-07T11:48:00Z", now), "12m");
  assert.equal(describeAge("2026-08-07T09:23:00Z", now), "2h37m");
  assert.equal(describeAge("nonsense", now), "unknown");
});

test("lockDir honours SYNC_LOCK_DIR and otherwise falls back to tmp", () => {
  assert.equal(lockDir({ SYNC_LOCK_DIR: "/custom/locks" }), "/custom/locks");
  assert.equal(lockDir({}), path.join(os.tmpdir(), "emberly-sync-locks"));
});
