const assert = require("node:assert/strict");
const test = require("node:test");

const { collectStalenessFindings, runMonitor, ANOMALY_WATCHES } = require("../lib/monitor");
const { RESMAN_RESOURCES } = require("../lib/resman-resources");

/**
 * The scheduled monitor.
 *
 * Two properties decide whether a monitoring table gets read or ignored: a
 * recurring finding must not duplicate nightly, and a finding that goes away
 * must stop looking live. Both are tested here. The staleness tests pin the two
 * false-positive classes that showed up the first time this ran against real
 * data.
 */

/** Client with per-table newest-timestamp answers and a recorded findings table. */
function monitorClient({ syncedAt = {}, findings = [] } = {}) {
  const upserts = [];
  const updates = [];
  return {
    upserts,
    updates,
    from(table) {
      if (table === "monitor_findings") {
        return {
          select: () => ({
            limit: () => Promise.resolve({ data: findings, error: null }),
            is: () => Promise.resolve({ data: findings, error: null }),
          }),
          upsert: (row) => {
            upserts.push(row);
            return Promise.resolve({ data: null, error: null });
          },
          update: (patch) => ({
            in: (_col, values) => {
              updates.push({ patch, values });
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }
      return {
        select: () => ({
          not: () => ({
            order: () => ({
              limit: () =>
                Promise.resolve({
                  data: syncedAt[table] ? [{ synced_at: syncedAt[table] }] : [],
                  error: null,
                }),
            }),
          }),
          // scanForSeries paging: return nothing, so no anomaly findings.
          order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }),
          eq() { return this; }, gte() { return this; }, lte() { return this; }, or() { return this; },
        }),
      };
    },
  };
}

const hours = (n) => new Date(Date.now() - n * 3_600_000).toISOString();

// ------------------------------------------------------------- staleness ---

test("staleness is measured against the MEDIAN, not the freshest resource", async () => {
  // Observed live: creating unit_snapshots made it the freshest table, and
  // against a maximum-based reference that instantly flagged EIGHT healthy
  // resources as 28h stale. The median only moves when half the mirror moves.
  const synced = {};
  for (const r of RESMAN_RESOURCES.filter((r) => r.selectColumns.includes("synced_at"))) {
    synced[r.table] = hours(2);
  }
  // One table written just now — the shape that broke the maximum.
  synced.resman_transactions = hours(0);

  const notes = [];
  const findings = await collectStalenessFindings(monitorClient({ syncedAt: synced }), notes);
  assert.deepEqual(findings, [], "a single unusually-fresh table is not an alarm for everything else");
});

test("a table that genuinely stopped syncing is still caught", async () => {
  const synced = {};
  for (const r of RESMAN_RESOURCES.filter((r) => r.selectColumns.includes("synced_at"))) {
    synced[r.table] = hours(1);
  }
  synced.resman_units = hours(274); // the real bug, eleven days frozen

  const findings = await collectStalenessFindings(monitorClient({ syncedAt: synced }), []);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].resource, "units");
  assert.equal(findings[0].severity, "critical");
  assert.equal(findings[0].fingerprint, "staleness|units");
});

test("tables written by activity rather than a sync are never flagged", async () => {
  // guest-passes was flagged at 340h behind simply because no new pass had been
  // issued. Quiet is not broken, and only sync-backed tables carry synced_at.
  const synced = {};
  for (const r of RESMAN_RESOURCES.filter((r) => r.selectColumns.includes("synced_at"))) {
    synced[r.table] = hours(1);
  }
  const findings = await collectStalenessFindings(monitorClient({ syncedAt: synced }), []);
  const names = findings.map((f) => f.resource);
  for (const activity of ["guest-passes", "entry-logs", "property-snapshots", "unit-snapshots"]) {
    assert.ok(!names.includes(activity), `${activity} has no sync to be behind on`);
  }
});

// ------------------------------------------------------- persistence loop ---

test("a recurring finding updates in place instead of duplicating nightly", async () => {
  const synced = {};
  for (const r of RESMAN_RESOURCES.filter((r) => r.selectColumns.includes("synced_at"))) {
    synced[r.table] = hours(1);
  }
  synced.resman_units = hours(274);

  const client = monitorClient({
    syncedAt: synced,
    findings: [{ fingerprint: "staleness|units", resolved_at: null }],
  });
  const result = await runMonitor(client);
  assert.equal(result.opened, 0, "already open");
  assert.equal(result.updated, 1);
  assert.equal(client.upserts.length, 1, "one upsert, not one insert per night");
  assert.equal(client.upserts[0].resolved_at, null);
});

test("a finding that stops recurring is resolved, not left looking live", async () => {
  const synced = {};
  for (const r of RESMAN_RESOURCES.filter((r) => r.selectColumns.includes("synced_at"))) {
    synced[r.table] = hours(1);
  }
  // Nothing stale this run, but a stale finding is open from before.
  const client = monitorClient({
    syncedAt: synced,
    findings: [{ fingerprint: "staleness|units", resolved_at: null }],
  });
  const result = await runMonitor(client);
  assert.equal(result.resolved, 1);
  assert.deepEqual(client.updates[0].values, ["staleness|units"]);
  assert.ok(client.updates[0].patch.resolved_at, "stamped with a resolution time");
});

test("an already-resolved finding is not resolved again", async () => {
  const synced = {};
  for (const r of RESMAN_RESOURCES.filter((r) => r.selectColumns.includes("synced_at"))) {
    synced[r.table] = hours(1);
  }
  const client = monitorClient({
    syncedAt: synced,
    findings: [{ fingerprint: "staleness|units", resolved_at: "2026-07-01T00:00:00Z" }],
  });
  const result = await runMonitor(client);
  assert.equal(result.resolved, 0);
  assert.equal(client.updates.length, 0);
});

// ------------------------------------------------------------- watch list ---

test("every anomaly watch names a real resource, entity, measure and period", () => {
  // A watch with a typo would silently monitor nothing, which is the worst
  // failure mode available to a monitor.
  const byName = new Map(RESMAN_RESOURCES.map((r) => [r.name, r]));
  for (const watch of ANOMALY_WATCHES) {
    const resource = byName.get(watch.resource);
    assert.ok(resource, `unknown resource ${watch.resource}`);
    assert.ok(resource.entities.includes(watch.entity), `${watch.resource} has no entity ${watch.entity}`);
    assert.ok(resource.measures.includes(watch.measure), `${watch.resource} has no measure ${watch.measure}`);
    assert.ok(resource.periods[watch.periodColumn], `${watch.resource} has no period ${watch.periodColumn}`);
  }
});
