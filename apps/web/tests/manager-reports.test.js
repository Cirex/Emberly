const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");
const { NextResponse } = require("next/server");

// Same bun:test mock.module harness as tests/manager-api.test.js — this suite
// runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files.
const state = {
  /** What requireResmanApiKey answers. */
  auth: { ok: false, response: null },
  /** Fake owner-reports storage bucket handle. */
  storage: null,
};

mock.module("@/lib/resman-api-auth", () => ({
  requireResmanApiKey: async () => state.auth,
}));

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: (bucket) => state.storage.open(bucket) } }),
  createUntypedAdminClient: () => {
    throw new Error("owner reports live in Storage, not tables");
  },
  getMissingSupabaseAdminEnvVars: () => [],
}));

const {
  OWNER_REPORTS_BUCKET,
  REPORT_LIST_CAP,
  isValidReportPeriod,
  parseOwnerReportSummary,
} = require("../lib/manager-reports");
const listRoute = require("../app/api/resman/manager/reports/route.ts");
const fileRoute = require("../app/api/resman/manager/reports/[period]/route.ts");

// --- shared fakes (mirrors tests/manager-api.test.js) ----------------------

function tokenAuth() {
  return {
    ok: true,
    kind: "token",
    subject: {
      tokenId: "token-1",
      kind: "api_resman",
      subjectType: "admin_user",
      subjectId: "admin-7",
      label: "Priya Manager",
      role: "staff",
      scopes: [],
    },
  };
}

/**
 * Scripted storage bucket: `objects` maps object name → string (JSON/HTML) or
 * Uint8Array (PDF). Tracks bucket names, list options, and download paths.
 */
function fakeStorage(objects = {}) {
  const calls = { buckets: [], lists: [], downloads: [] };
  return {
    calls,
    open(bucket) {
      calls.buckets.push(bucket);
      return {
        list: async (prefix, options) => {
          calls.lists.push({ prefix, options });
          const data = Object.keys(objects).map((name) => ({ name }));
          return { data, error: null };
        },
        download: async (path) => {
          calls.downloads.push(path);
          const body = objects[path];
          if (body === undefined) return { data: null, error: { message: "Object not found" } };
          const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
          return {
            data: {
              text: async () => new TextDecoder().decode(bytes),
              arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            },
            error: null,
          };
        },
      };
    },
  };
}

function figuresJson(overrides = {}) {
  return JSON.stringify({
    version: 1,
    period: "2026-07",
    generatedAt: "2026-08-01T06:00:00.000Z",
    occupancy: { pct: 92.4, momDeltaPts: 1.1 },
    collections: { billed: 1310000, collected: 1240000, ratePct: 94.66 },
    delinquency: { total: 48200, momDelta: -6100 },
    turns: { completed: 9 },
    ...overrides,
  });
}

function untouchableStorage() {
  return {
    open() {
      throw new Error("Storage must not be touched");
    },
  };
}

const listRequest = () => new Request("https://emberly-web.test/api/resman/manager/reports");
const fileRequest = (period) =>
  new Request(`https://emberly-web.test/api/resman/manager/reports/${period}`);
const fileParams = (period) => ({ params: Promise.resolve({ period }) });

// --- pure helpers -----------------------------------------------------------

test("isValidReportPeriod accepts strict YYYY-MM only", () => {
  assert.equal(isValidReportPeriod("2026-07"), true);
  assert.equal(isValidReportPeriod("2026-12"), true);
  assert.equal(isValidReportPeriod("2026-13"), false);
  assert.equal(isValidReportPeriod("2026-00"), false);
  assert.equal(isValidReportPeriod("2026-7"), false);
  assert.equal(isValidReportPeriod("2026-07.pdf"), false);
  assert.equal(isValidReportPeriod("../../etc/passwd"), false);
});

test("parseOwnerReportSummary is defensive: junk yields nulls, never throws", () => {
  const parsed = parseOwnerReportSummary(null);
  assert.equal(parsed.generatedAt, null);
  assert.deepEqual(parsed.summary, {
    occupancyPct: null,
    occupancyMomDeltaPts: null,
    collectionsRatePct: null,
    collected: null,
    billed: null,
    balanceTotal: null,
    balanceMomDelta: null,
    turnsCompleted: null,
  });
  assert.equal(parseOwnerReportSummary({ occupancy: "not-an-object" }).summary.occupancyPct, null);
  assert.equal(parseOwnerReportSummary({ occupancy: { pct: "92.4" } }).summary.occupancyPct, null);
});

// --- auth gating ------------------------------------------------------------

test("unauthenticated requests get 401 and never touch Storage", async () => {
  state.storage = untouchableStorage();
  const calls = [
    () => listRoute.GET(listRequest()),
    () => fileRoute.GET(fileRequest("2026-07"), fileParams("2026-07")),
  ];
  for (const call of calls) {
    // Fresh response per call — NextResponse bodies are single-use.
    state.auth = {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
    const response = await call();
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Unauthorized");
  }
});

test("scanner credentials are refused: owner reports are staff-only", async () => {
  state.storage = untouchableStorage();
  state.auth = { ok: true, kind: "scanner" };
  for (const response of [
    await listRoute.GET(listRequest()),
    await fileRoute.GET(fileRequest("2026-07"), fileParams("2026-07")),
  ]) {
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "Forbidden");
  }
});

// --- GET /manager/reports (the archive index) -------------------------------

test("GET reports lists periods newest first with parsed summaries", async () => {
  state.auth = tokenAuth();
  state.storage = fakeStorage({
    // Listing includes non-JSON siblings and junk — only period JSONs count.
    "2026-06.json": figuresJson({
      period: "2026-06",
      generatedAt: "2026-07-01T06:00:00.000Z",
      occupancy: { pct: 91.3, momDeltaPts: null },
      collections: { billed: 1300000, collected: 1219400, ratePct: 93.8 },
      delinquency: { total: 54300, momDelta: null },
      turns: { completed: 7 },
    }),
    "2026-07.json": figuresJson(),
    "2026-07.pdf": new Uint8Array([1, 2, 3]),
    "2026-07.html": "<!doctype html>",
    "notes.txt": "junk",
    "not-a-period.json": "{}",
  });

  const response = await listRoute.GET(listRequest());
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.reports.length, 2);
  assert.deepEqual(data.reports[0], {
    period: "2026-07",
    generatedAt: "2026-08-01T06:00:00.000Z",
    summary: {
      occupancyPct: 92.4,
      occupancyMomDeltaPts: 1.1,
      collectionsRatePct: 94.66,
      collected: 1240000,
      billed: 1310000,
      balanceTotal: 48200,
      balanceMomDelta: -6100,
      turnsCompleted: 9,
    },
  });
  assert.equal(data.reports[1].period, "2026-06");
  assert.equal(data.reports[1].summary.occupancyMomDeltaPts, null);
  assert.deepEqual(state.storage.calls.buckets, [OWNER_REPORTS_BUCKET]);
  // Only the period JSONs were downloaded — never the PDFs/HTML.
  assert.deepEqual([...state.storage.calls.downloads].sort(), ["2026-06.json", "2026-07.json"]);
});

test("GET reports caps the archive at 24 periods", async () => {
  state.auth = tokenAuth();
  const objects = {};
  for (let i = 0; i < 30; i += 1) {
    const year = 2024 + Math.floor(i / 12);
    const month = String((i % 12) + 1).padStart(2, "0");
    objects[`${year}-${month}.json`] = figuresJson({ period: `${year}-${month}` });
  }
  state.storage = fakeStorage(objects);

  const response = await listRoute.GET(listRequest());
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(REPORT_LIST_CAP, 24);
  assert.equal(data.reports.length, 24);
  assert.equal(data.reports[0].period, "2026-06"); // newest of the 30
  assert.equal(data.reports.at(-1).period, "2024-07"); // oldest 6 dropped
});

test("a malformed archive JSON degrades to nulls instead of blanking the list", async () => {
  state.auth = tokenAuth();
  state.storage = fakeStorage({
    "2026-07.json": "{not json",
    "2026-06.json": figuresJson({ period: "2026-06" }),
  });
  const response = await listRoute.GET(listRequest());
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.reports.length, 2);
  assert.equal(data.reports[0].summary.occupancyPct, null);
  assert.equal(data.reports[1].summary.occupancyPct, 92.4);
});

test("GET reports answers 500 when the bucket listing fails", async () => {
  state.auth = tokenAuth();
  state.storage = {
    open: () => ({
      list: async () => ({ data: null, error: { message: "boom" } }),
      download: async () => ({ data: null, error: { message: "boom" } }),
    }),
  };
  const response = await listRoute.GET(listRequest());
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "Internal server error");
});

// --- GET /manager/reports/[period] (the document) ---------------------------

test("junk periods are rejected 400 before Storage is touched", async () => {
  state.auth = tokenAuth();
  state.storage = untouchableStorage();
  for (const junk of ["2026-13", "2026-7", "latest", "2026-07.pdf", "..%2F.."]) {
    const response = await fileRoute.GET(fileRequest(junk), fileParams(junk));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Invalid period");
  }
});

test("GET a period streams the PDF bytes with the PDF content type", async () => {
  state.auth = tokenAuth();
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
  state.storage = fakeStorage({ "2026-07.pdf": pdfBytes, "2026-07.html": "<p>hi</p>" });

  const response = await fileRoute.GET(fileRequest("2026-07"), fileParams("2026-07"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(
    response.headers.get("content-disposition"),
    'inline; filename="emberly-owner-report-2026-07.pdf"',
  );
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdfBytes);
  // The PDF won: the HTML fallback was never downloaded.
  assert.deepEqual(state.storage.calls.downloads, ["2026-07.pdf"]);
});

test("a PDF-less period falls back to streaming the stored HTML", async () => {
  state.auth = tokenAuth();
  state.storage = fakeStorage({ "2026-07.html": "<!doctype html><p>report</p>" });

  const response = await fileRoute.GET(fileRequest("2026-07"), fileParams("2026-07"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html");
  assert.equal(
    response.headers.get("content-disposition"),
    'inline; filename="emberly-owner-report-2026-07.html"',
  );
  assert.equal(await response.text(), "<!doctype html><p>report</p>");
  assert.deepEqual(state.storage.calls.downloads, ["2026-07.pdf", "2026-07.html"]);
});

test("an unknown period answers 404", async () => {
  state.auth = tokenAuth();
  state.storage = fakeStorage({});
  const response = await fileRoute.GET(fileRequest("2019-01"), fileParams("2019-01"));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Report not found");
});
