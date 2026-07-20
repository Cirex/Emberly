
const assert = require("node:assert/strict");
const test = require("node:test");

const { ResManRequestScheduler } = require("../src/resman/scheduler");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ported from ResManRequestSchedulerTests.swift.

test("limits concurrent requests to the configured maximum", async () => {
  const scheduler = new ResManRequestScheduler(3);
  let active = 0;
  let maxActive = 0;

  await Promise.all(
    Array.from({ length: 12 }, () =>
      scheduler.withPermit(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
      }),
    ),
  );

  assert.ok(maxActive <= 3, `maxActive was ${maxActive}`);
});

test("releases a slot after an operation throws", async () => {
  const scheduler = new ResManRequestScheduler(1);

  await assert.rejects(
    scheduler.withPermit(async () => {
      throw new Error("failed");
    }),
  );

  const value = await scheduler.withPermit(async () => 42);
  assert.equal(value, 42);
});

test("resumes queued requests in FIFO order when a slot opens", async () => {
  const scheduler = new ResManRequestScheduler(1);
  const events = [];

  const first = scheduler.withPermit(async () => {
    events.push("first-start");
    await delay(60);
    events.push("first-end");
  });

  await delay(10);

  const second = scheduler.withPermit(async () => {
    events.push("second-start");
  });

  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});

test("snapshot reports high-water mark and completed counts", async () => {
  const scheduler = new ResManRequestScheduler(2);
  await Promise.all([
    scheduler.withPermit(async () => delay(10)),
    scheduler.withPermit(async () => delay(10)),
    scheduler.withPermit(async () => delay(10)),
  ]);
  const snap = scheduler.snapshot();
  assert.equal(snap.completedRequests, 3);
  assert.ok(snap.highWaterMark <= 2 && snap.highWaterMark >= 1);
  assert.equal(snap.activeRequests, 0);
});
