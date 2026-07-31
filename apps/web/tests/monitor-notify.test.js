const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDigestBody,
  buildMonitorPushMessages,
  notifyMonitorFindings,
  MONITOR_ALERT_KIND,
} = require("../lib/monitor-notify");

/**
 * Monitor notifications.
 *
 * Two rules carry the weight. A push body renders on a LOCKED SCREEN in public,
 * and an anomaly summary names a service address — so no finding detail may
 * ever reach the message. And an alert that repeats nightly for as long as a
 * problem lasts is an alert people switch off, so a finding announces once.
 */

const finding = (over = {}) => ({
  fingerprint: "anomaly|mlgw/bills|acct-1|2026-07|amount_due",
  kind: "anomaly",
  severity: "critical",
  resource: "mlgw/bills",
  entity: "489f05ba|account|1709 commonwealth dr apt 1",
  period: "2026-07",
  summary: "amount_due rose to 606.74 in 2026-07, against a baseline of 40.39 over 9 periods (1402%)",
  detail: { z: 388.5 },
  ...over,
});

/** Client over in-memory tables, recording updates. */
function notifyClient({ findings = [], tokens = [] } = {}) {
  const updates = [];
  return {
    updates,
    from(table) {
      return {
        select: () => ({
          in: (_c, values) => Promise.resolve({
            data: findings.filter((f) => values.includes(f.fingerprint)), error: null,
          }),
          eq() { return this; },
          then: (resolve) => resolve({ data: tokens, error: null }),
        }),
        update: (patch) => ({
          in: (column, values) => {
            updates.push({ table, patch, column, values });
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
    },
  };
}

// --------------------------------------------------------------- privacy ---

test("the push body carries no finding detail whatsoever", () => {
  const { title, body } = buildDigestBody([finding(), finding({ fingerprint: "b" })]);
  const text = `${title} ${body}`;
  assert.ok(!text.includes("commonwealth"), "no address on a lock screen");
  assert.ok(!text.includes("606.74"), "no amount");
  assert.ok(!text.includes("acct-1"));
  assert.match(text, /2 new critical findings/);
  assert.match(text, /Open Emberly to review/);
});

test("the push payload carries a route, not the finding", () => {
  const [message] = buildMonitorPushMessages([{ expo_push_token: "tok", alert_kinds: null }], [finding()]);
  const serialised = JSON.stringify(message);
  assert.ok(!serialised.includes("commonwealth"));
  assert.ok(!serialised.includes("606.74"));
  assert.deepEqual(message.data, { route: "/monitor", kind: MONITOR_ALERT_KIND, count: 1 });
});

test("singular and plural read correctly", () => {
  assert.match(buildDigestBody([finding()]).title, /^New critical finding$/);
  assert.match(buildDigestBody([finding()]).body, /1 anomaly\./);
  assert.match(
    buildDigestBody([finding(), finding({ kind: "staleness" })]).body,
    /1 anomaly, 1 stale data source\./,
  );
});

// ---------------------------------------------------------------- digest ---

test("one digest goes to each device, not one push per finding", () => {
  const many = Array.from({ length: 14 }, (_, i) => finding({ fingerprint: `f${i}` }));
  const messages = buildMonitorPushMessages(
    [{ expo_push_token: "a", alert_kinds: null }, { expo_push_token: "b", alert_kinds: null }],
    many,
  );
  assert.equal(messages.length, 2, "two devices, one message each — not 28");
  assert.match(messages[0].title, /14 new critical findings/);
});

test("devices that opted out of this kind are skipped", () => {
  const tokens = [
    { expo_push_token: "opted-in", alert_kinds: [MONITOR_ALERT_KIND] },
    { expo_push_token: "other-kinds", alert_kinds: ["emergency"] },
    { expo_push_token: "no-preference", alert_kinds: [] },
    { expo_push_token: "null-preference", alert_kinds: null },
  ];
  const to = buildMonitorPushMessages(tokens, [finding()]).map((m) => m.to);
  assert.deepEqual(to, ["opted-in", "no-preference", "null-preference"]);
});

// ------------------------------------------------------------- send once ---

test("only critical findings are announced", async () => {
  const client = notifyClient({ findings: [], tokens: [{ expo_push_token: "t", alert_kinds: null }] });
  const result = await notifyMonitorFindings(client, [finding({ severity: "warn" })]);
  assert.equal(result.considered, 0);
  assert.equal(result.skipped, "nothing critical");
});

test("a finding already announced is not announced again", async () => {
  // The monitor updates a persisting finding in place every night. Without
  // this, a problem lasting a week alerts seven times.
  const client = notifyClient({
    findings: [{ fingerprint: finding().fingerprint, notified_at: "2026-07-30T00:00:00Z" }],
    tokens: [{ expo_push_token: "t", alert_kinds: null }],
  });
  const result = await notifyMonitorFindings(client, [finding()]);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, "all already notified");
  assert.equal(client.updates.length, 0);
});

test("with no registered device the finding is still marked announced", async () => {
  // Otherwise the first device to register weeks later receives a digest about
  // findings that are long resolved.
  const client = notifyClient({
    findings: [{ fingerprint: finding().fingerprint, notified_at: null }],
    tokens: [],
  });
  const result = await notifyMonitorFindings(client, [finding()]);
  assert.equal(result.skipped, "no registered manager devices");
  assert.equal(client.updates.length, 1);
  assert.ok(client.updates[0].patch.notified_at);
});

test("a send that fails entirely leaves the finding unannounced for a retry", async () => {
  const client = notifyClient({
    findings: [{ fingerprint: finding().fingerprint, notified_at: null }],
    tokens: [{ expo_push_token: "t", alert_kinds: null }],
  });
  // No fetch available in this environment path -> the core sender counts a
  // failure rather than throwing, and nothing must be marked notified.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const result = await notifyMonitorFindings(client, [finding()]);
    assert.equal(result.sent, 0);
    assert.equal(result.notified, 0);
    const marked = client.updates.filter((u) => u.patch.notified_at);
    assert.equal(marked.length, 0, "a failed send must be retried, not silently dropped");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
