const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EXPO_PUSH_URL,
  buildEmergencyPushMessages,
  chunkPushMessages,
  detectNewEmergencies,
  sendExpoPushMessages,
} = require("../src/shared/push.ts");

function woRow(overrides = {}) {
  return {
    resman_work_order_id: "wo-1",
    unit_number: "3644 DU-1",
    title: "Water leak in kitchen",
    status: "Not Started",
    priority: "Emergency",
    ...overrides,
  };
}

test("detectNewEmergencies only flags rows absent from the pre-upsert id set", () => {
  const rows = [
    woRow({ resman_work_order_id: "known" }),
    woRow({ resman_work_order_id: "fresh" }),
  ];
  const found = detectNewEmergencies(new Set(["known"]), rows);
  assert.deepEqual(found.map((wo) => wo.workOrderId), ["fresh"]);
  assert.deepEqual(found[0], {
    workOrderId: "fresh",
    unitNumber: "3644 DU-1",
    title: "Water leak in kitchen",
  });
});

test("detectNewEmergencies filters on Emergency priority and open status", () => {
  const rows = [
    woRow({ resman_work_order_id: "a", priority: "High" }),
    woRow({ resman_work_order_id: "b", priority: "Normal" }),
    woRow({ resman_work_order_id: "c", status: "Completed" }),
    woRow({ resman_work_order_id: "d", status: "Closed" }),
    woRow({ resman_work_order_id: "e", status: "Canceled" }),
    woRow({ resman_work_order_id: "f", status: "In Progress" }),
    woRow({ resman_work_order_id: "g", status: "Scheduled" }),
    woRow({ resman_work_order_id: "h", status: "Not Started" }),
    woRow({ resman_work_order_id: "" }),
  ];
  const found = detectNewEmergencies(new Set(), rows);
  assert.deepEqual(found.map((wo) => wo.workOrderId), ["f", "g", "h"]);
});

test("buildEmergencyPushMessages builds one message per token with truncated title", () => {
  const longTitle = "x".repeat(150);
  const messages = buildEmergencyPushMessages(
    { workOrderId: "wo-9", unitNumber: "1726 ST-4", title: longTitle },
    ["ExponentPushToken[aaa]", "ExponentPushToken[bbb]"],
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0].to, "ExponentPushToken[aaa]");
  assert.equal(messages[1].to, "ExponentPushToken[bbb]");
  for (const message of messages) {
    assert.equal(message.title, "Emergency work order");
    assert.equal(message.body, `1726 ST-4 · ${"x".repeat(120)}…`);
    assert.equal(message.sound, "default");
    assert.equal(message.priority, "high");
    assert.deepEqual(message.data, { workOrderId: "wo-9", unitNumber: "1726 ST-4" });
  }
});

test("buildEmergencyPushMessages keeps short titles untouched", () => {
  const [message] = buildEmergencyPushMessages(
    { workOrderId: "wo-1", unitNumber: "12", title: "No heat" },
    ["ExponentPushToken[aaa]"],
  );
  assert.equal(message.body, "12 · No heat");
});

test("chunkPushMessages splits at 100 by default", () => {
  const chunks = chunkPushMessages(Array.from({ length: 250 }, (_, i) => i));
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
  assert.deepEqual(chunkPushMessages([]), []);
});

function okTickets(count) {
  return { data: Array.from({ length: count }, (_, i) => ({ status: "ok", id: `t-${i}` })) };
}

test("sendExpoPushMessages posts JSON chunks of 100 to the Expo API", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => okTickets(JSON.parse(init.body).length) };
  };
  const messages = buildEmergencyPushMessages(
    { workOrderId: "wo-1", unitNumber: "12", title: "No heat" },
    Array.from({ length: 130 }, (_, i) => `ExponentPushToken[${i}]`),
  );

  const result = await sendExpoPushMessages(messages, { fetchFn });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, EXPO_PUSH_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(JSON.parse(calls[0].init.body).length, 100);
  assert.equal(JSON.parse(calls[1].init.body).length, 30);
  assert.deepEqual(result, { sent: 130, failed: 0, invalidTokens: [] });
});

test("sendExpoPushMessages surfaces DeviceNotRegistered tokens for deactivation", async () => {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [
        { status: "ok", id: "t-0" },
        { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        { status: "error", message: "rate limited", details: { error: "MessageRateExceeded" } },
      ],
    }),
  });
  const messages = buildEmergencyPushMessages(
    { workOrderId: "wo-1", unitNumber: "12", title: "No heat" },
    ["ExponentPushToken[a]", "ExponentPushToken[b]", "ExponentPushToken[c]"],
  );

  const result = await sendExpoPushMessages(messages, { fetchFn });
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.invalidTokens, ["ExponentPushToken[b]"]);
});

test("sendExpoPushMessages never throws on transport or HTTP failures", async () => {
  const messages = buildEmergencyPushMessages(
    { workOrderId: "wo-1", unitNumber: "12", title: "No heat" },
    ["ExponentPushToken[a]", "ExponentPushToken[b]"],
  );
  const logs = [];

  const thrown = await sendExpoPushMessages(messages, {
    fetchFn: async () => {
      throw new Error("network down");
    },
    log: (m) => logs.push(m),
  });
  assert.deepEqual(thrown, { sent: 0, failed: 2, invalidTokens: [] });

  const http500 = await sendExpoPushMessages(messages, {
    fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(http500, { sent: 0, failed: 2, invalidTokens: [] });
  assert.equal(logs.length, 2);
});

test("sendExpoPushMessages treats a malformed ticket body as failure", async () => {
  const messages = buildEmergencyPushMessages(
    { workOrderId: "wo-1", unitNumber: "12", title: "No heat" },
    ["ExponentPushToken[a]"],
  );
  const result = await sendExpoPushMessages(messages, {
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }),
  });
  assert.deepEqual(result, { sent: 0, failed: 1, invalidTokens: [] });
});
