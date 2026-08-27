const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const { ResManClient } = require("../src/resman/client");
const { MULTI_SOUTH_CONFIGURATION } = require("../src/resman/config");
const {
  applyWorkOrderWrite,
  verifyWorkOrderWrite,
  WorkOrderWriteRefused,
} = require("../src/resman/write/work-orders");
const { resolveTechnician } = require("../src/resman/write/employees");

/**
 * Full write flows against the REAL captured edit pages, with a scripted
 * transport. Every guard that keeps this path "edits and closes only" gets an
 * attack test — a writer bug here corrupts live property-management data, so
 * the guards are the product.
 */

const fixture = (name) =>
  readFileSync(path.join(__dirname, "fixtures", `work-order-edit-${name}.html`), "utf8");

const WO_16305 = "6f09851a-df4e-488f-a86b-de4a60bd4225"; // unit-scoped, Not Started
const WO_16376 = "d1737525-2f29-4608-a9c6-7d579e23feb0"; // building-scoped, Completed
const UNIT_16305 = "a478dccd-7823-463d-8df4-a2adacb573c1";
const BASE = MULTI_SOUTH_CONFIGURATION.consumerStartUrl.replace(/\/$/, "");
const NOW = () => new Date("2026-08-27T00:43:00Z"); // 7:43:00 PM Memphis

/** Minimal Response stand-in for ResManClient.fetchFollowing. */
function fakeResponse({ status = 200, body = "", headers = {}, url = "" }) {
  return {
    status,
    url,
    headers: new Headers(headers),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

/**
 * A scripted transport: GETs are answered from `pages` (keyed by URL), POSTs
 * are recorded and answered 302, and every GET after the POST is answered
 * from `pagesAfterPost` when provided (the "did it land?" read).
 */
function makeTransport({ pages, pagesAfterPost = null, postStatus = 302, postBody = "" }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body });
    if (method === "POST") {
      return fakeResponse({
        status: postStatus,
        body: postBody,
        headers: postStatus >= 300 && postStatus < 400 ? { location: url } : {},
      });
    }
    const posted = calls.some((call) => call.method === "POST");
    const source = posted && pagesAfterPost ? pagesAfterPost : pages;
    const page = source[url];
    if (!page) throw new Error(`unscripted GET ${url}`);
    return fakeResponse({ status: 200, body: page, url });
  };
  return { calls, fetchImpl };
}

function makeClient(fetchImpl) {
  return new ResManClient(MULTI_SOUTH_CONFIGURATION, { fetchImpl });
}

const posts = (calls) => calls.filter((call) => call.method === "POST");
const decodePairs = (body) =>
  body.split("&").map((pair) => {
    const [k, v = ""] = pair.split("=");
    return [decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, "%20"))];
  });

/** Targeted fixture surgery so the verify read sees the values "landed". */
function landClose(html, { note, completedBy }) {
  let out = html
    .replace('<option selected="selected">Not Started</option>', "<option>Not Started</option>")
    .replace("<option>Completed</option>", '<option selected="selected">Completed</option>')
    .replace('id="CompletedDate" name="CompletedDate" type="hidden" value=""', 'id="CompletedDate" name="CompletedDate" type="hidden" value="8/26/2026 7:43:00 PM"')
    .replace(/(id="CompletedDate_Date"[^>]*value=")(")/, "$108/26/2026$2");
  if (completedBy) {
    out = out.replace(
      '<select data-selected-value="" id="CompletedByPersonID"',
      `<select data-selected-value="${completedBy}" id="CompletedByPersonID"`,
    );
  }
  if (note) {
    out = out.replace(
      /(name="CompletedNotes"[^>]*>)([^<]*)(<\/textarea>)/,
      (match, open, _oldValue, close) => `${open}${note}${close}`,
    );
  }
  return out;
}

const EDIT_URL_16305 = `${BASE}/WorkOrders/Edit/${WO_16305}`;
const EDIT_URL_16376 = `${BASE}/WorkOrders/Edit/${WO_16376}`;

// MARK: - The close flow, end to end

test("close: POSTs the full form with Status=Completed and verifies on a re-read", async () => {
  const landed = landClose(fixture("16305"), {
    note: "Relit water heater",
    completedBy: "7a2f5c20-42af-4e4e-808e-45bd64ae89c2", // the assignee
  });
  const transport = makeTransport({
    pages: { [EDIT_URL_16305]: fixture("16305") },
    pagesAfterPost: { [EDIT_URL_16305]: landed },
  });
  const result = await applyWorkOrderWrite({
    client: makeClient(transport.fetchImpl),
    request: {
      workOrderId: WO_16305,
      kind: "close",
      patch: { note: "Relit water heater", completedAt: "2026-08-27T00:43:00Z" },
      expectedUnitId: UNIT_16305,
    },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.phase, "verified");
  assert.equal(result.noop, false);
  assert.equal(result.postStatus, 302);

  const sent = posts(transport.calls);
  assert.equal(sent.length, 1, "exactly one POST");
  assert.equal(sent[0].url, EDIT_URL_16305, "POST goes to the Edit URL and nowhere else");
  const pairs = decodePairs(sent[0].body);
  const byName = Object.fromEntries(pairs);
  assert.equal(byName.Status, "Completed");
  assert.equal(byName.CompletedDate, "8/26/2026 7:43:00 PM");
  assert.equal(byName.CompletedDate_Date, "08/26/2026");
  assert.equal(byName["CompletedDate.Time"], "");
  assert.equal(byName.CompletedNotes, "Relit water heater");
  // ResMan credits the assignee: CompletedBy filled from AssignedTo.
  assert.equal(byName.CompletedByPersonID, "7a2f5c20-42af-4e4e-808e-45bd64ae89c2");
  // ObjectID rides along from data-selected-value — the async-populated
  // required field a naive replay would omit.
  assert.equal(byName.ObjectID, UNIT_16305);
  assert.equal(byName.ObjectType, "Unit");
  // The synthesized Location display pair: ResMan persists its denormalized
  // ObjectName from this text on every save — omitting it blanks the unit
  // name off every list (verified live on WOs 14627/16376, 2026-08-27).
  assert.equal(byName.Location, "3723 CC-6");
  const names = pairs.map(([name]) => name);
  assert.equal(names[names.indexOf("ObjectID") + 1], "Location", "Location sits right after ObjectID");
  // Echo fields are byte-faithful.
  assert.equal(byName.SaveAndNew, "False");
  assert.equal(byName.AddRetentionEffortNote, "false");
  assert.equal(byName.CancellationReasonPickListItemID, "");
  assert.equal(byName.CancellationDate, "");
  assert.equal(byName.ScheduledDate, "9/2/2026 9:30:00 AM"); // untouched
});

test("close: verify failure reports phase=verified and does not re-POST", async () => {
  // The re-read serves the UNCHANGED page — the save silently didn't land.
  const transport = makeTransport({
    pages: { [EDIT_URL_16305]: fixture("16305") },
  });
  const result = await applyWorkOrderWrite({
    client: makeClient(transport.fetchImpl),
    request: { workOrderId: WO_16305, kind: "close", patch: {}, expectedUnitId: UNIT_16305 },
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.phase, "verified");
  assert.match(result.detail, /did not land/);
  assert.equal(posts(transport.calls).length, 1);
});

test("close: an already-Completed work order with no new note is a no-op (no POST)", async () => {
  const transport = makeTransport({ pages: { [EDIT_URL_16376]: fixture("16376") } });
  const result = await applyWorkOrderWrite({
    client: makeClient(transport.fetchImpl),
    request: { workOrderId: WO_16376, kind: "close", patch: {}, expectedUnitId: null },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.noop, true);
  assert.equal(posts(transport.calls).length, 0);
});

// MARK: - The edit flow

test("edit: reassign + notes changes exactly those pairs and nothing else", async () => {
  const technician = "55e3d0ac-69e5-434b-b6fe-23fce4131ffb";
  let landed = fixture("16305").replace(
    'data-selected-value="7a2f5c20-42af-4e4e-808e-45bd64ae89c2"',
    `data-selected-value="${technician}"`,
  );
  landed = landed.replace(
    /(name="CompletedNotes"[^>]*>)([^<]*)(<\/textarea>)/,
    "$1Parts on order$3",
  );
  const transport = makeTransport({
    pages: { [EDIT_URL_16305]: fixture("16305") },
    pagesAfterPost: { [EDIT_URL_16305]: landed },
  });
  const result = await applyWorkOrderWrite({
    client: makeClient(transport.fetchImpl),
    request: {
      workOrderId: WO_16305,
      kind: "edit",
      patch: { technicianPersonId: technician, completionNotes: "Parts on order" },
      expectedUnitId: UNIT_16305,
    },
    now: NOW,
  });
  assert.equal(result.ok, true);

  const pairs = decodePairs(posts(transport.calls)[0].body);
  const byName = Object.fromEntries(pairs);
  assert.equal(byName.AssignedToPersonID, technician);
  assert.equal(byName.CompletedNotes, "Parts on order");
  // Status untouched on an edit.
  assert.equal(byName.Status, "Not Started");
  assert.equal(byName.CompletedDate, "");
});

test("edit: clearing the booking empties the ScheduledDate pair and its twin", async () => {
  let landed = fixture("16305")
    .replace('name="ScheduledDate" type="hidden" value="9/2/2026 9:30:00 AM"', 'name="ScheduledDate" type="hidden" value=""')
    .replace(/(id="ScheduledDate_Date"[^>]*value=")09\/02\/2026(")/, "$1$2");
  const transport = makeTransport({
    pages: { [EDIT_URL_16305]: fixture("16305") },
    pagesAfterPost: { [EDIT_URL_16305]: landed },
  });
  const result = await applyWorkOrderWrite({
    client: makeClient(transport.fetchImpl),
    request: {
      workOrderId: WO_16305,
      kind: "edit",
      patch: { scheduledAt: null },
      expectedUnitId: UNIT_16305,
    },
    now: NOW,
  });
  assert.equal(result.ok, true);
  const byName = Object.fromEntries(decodePairs(posts(transport.calls)[0].body));
  assert.equal(byName.ScheduledDate, "");
  assert.equal(byName.ScheduledDate_Date, "");
});

test("edit: a locked (hidden) Description refuses instead of forcing the write", async () => {
  const transport = makeTransport({ pages: { [EDIT_URL_16305]: fixture("16305") } });
  await assert.rejects(
    applyWorkOrderWrite({
      client: makeClient(transport.fetchImpl),
      request: {
        workOrderId: WO_16305,
        kind: "edit",
        patch: { description: "New description" },
        expectedUnitId: UNIT_16305,
      },
      now: NOW,
    }),
    (error) => error instanceof WorkOrderWriteRefused && /locked/.test(error.message),
  );
  assert.equal(posts(transport.calls).length, 0, "nothing was POSTed");
});

test("edit: description is sanitized to ResMan's own limits (no <>, 248 max)", async () => {
  const wanted = "Fix <br> the a/c " + "x".repeat(300);
  const sanitized = ("Fix br the a/c " + "x".repeat(300)).slice(0, 248);
  let landed = fixture("16376").replace('value="Research 4"', `value="${sanitized}"`);
  const transport = makeTransport({
    pages: { [EDIT_URL_16376]: fixture("16376") },
    pagesAfterPost: { [EDIT_URL_16376]: landed },
  });
  const result = await applyWorkOrderWrite({
    client: makeClient(transport.fetchImpl),
    request: {
      workOrderId: WO_16376,
      kind: "edit",
      patch: { description: wanted },
      expectedUnitId: null,
    },
    now: NOW,
  });
  assert.equal(result.ok, true);
  const byName = Object.fromEntries(decodePairs(posts(transport.calls)[0].body));
  assert.equal(byName.Description, sanitized);
  assert.equal(byName.Description.length, 248);
});

test("close: folded edit fields land in the SAME update (one POST, not two)", async () => {
  // The app coalesces a pending notes/reassignment edit into the close so
  // ResMan gets one form replay. Reassignment applies BEFORE the CompletedBy
  // fill, so the completion credit follows the new assignee.
  const technician = "55e3d0ac-69e5-434b-b6fe-23fce4131ffb";
  let landed = landClose(fixture("16305"), { note: "", completedBy: technician });
  landed = landed
    .replace('data-selected-value="7a2f5c20-42af-4e4e-808e-45bd64ae89c2"', `data-selected-value="${technician}"`)
    .replace(/(name="CompletedNotes"[^>]*>)([^<]*)(<\/textarea>)/, "$1Relit pilot$3");
  const transport = makeTransport({
    pages: { [EDIT_URL_16305]: fixture("16305") },
    pagesAfterPost: { [EDIT_URL_16305]: landed },
  });
  const result = await applyWorkOrderWrite({
    client: makeClient(transport.fetchImpl),
    request: {
      workOrderId: WO_16305,
      kind: "close",
      patch: {
        completionNotes: "Relit pilot",
        technicianPersonId: technician,
        completedAt: "2026-08-27T00:43:00Z",
      },
      expectedUnitId: UNIT_16305,
    },
    now: NOW,
  });
  assert.equal(result.ok, true);
  const sent = posts(transport.calls);
  assert.equal(sent.length, 1, "one POST carries close AND edit");
  const byName = Object.fromEntries(decodePairs(sent[0].body));
  assert.equal(byName.Status, "Completed");
  assert.equal(byName.CompletedNotes, "Relit pilot");
  assert.equal(byName.AssignedToPersonID, technician);
  // CompletedBy follows the NEW assignee — reassignment applied first.
  assert.equal(byName.CompletedByPersonID, technician);
});

test("close: an explicit close note beats folded typed notes", async () => {
  const landed = landClose(fixture("16305"), {
    note: "Final word",
    completedBy: "7a2f5c20-42af-4e4e-808e-45bd64ae89c2",
  });
  const transport = makeTransport({
    pages: { [EDIT_URL_16305]: fixture("16305") },
    pagesAfterPost: { [EDIT_URL_16305]: landed },
  });
  const result = await applyWorkOrderWrite({
    client: makeClient(transport.fetchImpl),
    request: {
      workOrderId: WO_16305,
      kind: "close",
      patch: { note: "Final word", completionNotes: "older draft", completedAt: "2026-08-27T00:43:00Z" },
      expectedUnitId: UNIT_16305,
    },
    now: NOW,
  });
  assert.equal(result.ok, true);
  const byName = Object.fromEntries(decodePairs(posts(transport.calls)[0].body));
  assert.equal(byName.CompletedNotes, "Final word");
});

test("guard: a page without the location display name refuses (never blank it)", async () => {
  const stripped = fixture("16305").replace(/var workOrderableObjects = \[[^\]]*\];/, "var workOrderableObjects = [];");
  const transport = makeTransport({ pages: { [EDIT_URL_16305]: stripped } });
  await assert.rejects(
    applyWorkOrderWrite({
      client: makeClient(transport.fetchImpl),
      request: { workOrderId: WO_16305, kind: "close", patch: {}, expectedUnitId: UNIT_16305 },
      now: NOW,
    }),
    (error) => error instanceof WorkOrderWriteRefused && /display name/.test(error.message),
  );
  assert.equal(posts(transport.calls).length, 0);
});

// MARK: - Guards (each one an attack)

test("guard: a Cancelled work order is refused before any POST", async () => {
  const cancelled = fixture("16305")
    .replace('<option selected="selected">Not Started</option>', "<option>Not Started</option>")
    .replace("<option>Cancelled</option>", '<option selected="selected">Cancelled</option>');
  const transport = makeTransport({ pages: { [EDIT_URL_16305]: cancelled } });
  await assert.rejects(
    applyWorkOrderWrite({
      client: makeClient(transport.fetchImpl),
      request: { workOrderId: WO_16305, kind: "close", patch: {}, expectedUnitId: UNIT_16305 },
      now: NOW,
    }),
    (error) => error instanceof WorkOrderWriteRefused && /Cancelled/.test(error.message),
  );
  assert.equal(posts(transport.calls).length, 0);
});

test("guard: populated cancellation state is refused", async () => {
  const withCancellation = fixture("16305").replace(
    /(id="CancellationDate" name="CancellationDate" type="text" value=")(")/,
    "$108/25/2026$2",
  );
  const transport = makeTransport({ pages: { [EDIT_URL_16305]: withCancellation } });
  await assert.rejects(
    applyWorkOrderWrite({
      client: makeClient(transport.fetchImpl),
      request: { workOrderId: WO_16305, kind: "close", patch: {}, expectedUnitId: UNIT_16305 },
      now: NOW,
    }),
    (error) => error instanceof WorkOrderWriteRefused && /cancellation state/.test(error.message),
  );
});

test("guard: an unknown form field aborts as form drift", async () => {
  const drifted = fixture("16305").replace(
    '<input id="TempDocObjectID"',
    '<input name="BrandNewResManField" value="?" /><input id="TempDocObjectID"',
  );
  const transport = makeTransport({ pages: { [EDIT_URL_16305]: drifted } });
  await assert.rejects(
    applyWorkOrderWrite({
      client: makeClient(transport.fetchImpl),
      request: { workOrderId: WO_16305, kind: "close", patch: {}, expectedUnitId: UNIT_16305 },
      now: NOW,
    }),
    (error) => error instanceof WorkOrderWriteRefused && /form drift/.test(error.message),
  );
});

test("guard: a missing ObjectID refuses rather than severing the location", async () => {
  const noObject = fixture("16305").replace(
    'data-selected-value="a478dccd-7823-463d-8df4-a2adacb573c1" ',
    "",
  );
  const transport = makeTransport({ pages: { [EDIT_URL_16305]: noObject } });
  await assert.rejects(
    applyWorkOrderWrite({
      client: makeClient(transport.fetchImpl),
      request: { workOrderId: WO_16305, kind: "close", patch: {}, expectedUnitId: UNIT_16305 },
      now: NOW,
    }),
    (error) => error instanceof WorkOrderWriteRefused && /ObjectID/.test(error.message),
  );
});

test("guard: ObjectID that contradicts the mirror's unit refuses", async () => {
  const transport = makeTransport({ pages: { [EDIT_URL_16305]: fixture("16305") } });
  await assert.rejects(
    applyWorkOrderWrite({
      client: makeClient(transport.fetchImpl),
      request: {
        workOrderId: WO_16305,
        kind: "close",
        patch: {},
        expectedUnitId: "00000000-0000-0000-0000-00000000dead",
      },
      now: NOW,
    }),
    (error) => error instanceof WorkOrderWriteRefused && /does not match the mirror/.test(error.message),
  );
});

test("guard: editing a Closed work order is refused; closing one is a no-op", async () => {
  const closed = fixture("16376")
    .replace('<option selected="selected">Completed</option>', "<option>Completed</option>")
    .replace("<option>Closed</option>", '<option selected="selected">Closed</option>');
  const transport = makeTransport({ pages: { [EDIT_URL_16376]: closed } });
  await assert.rejects(
    applyWorkOrderWrite({
      client: makeClient(transport.fetchImpl),
      request: {
        workOrderId: WO_16376,
        kind: "edit",
        patch: { completionNotes: "late note" },
        expectedUnitId: null,
      },
      now: NOW,
    }),
    (error) => error instanceof WorkOrderWriteRefused && /Closed/.test(error.message),
  );
  // A close row for it retires quietly — even with a note, Closed is history.
  const closeResult = await applyWorkOrderWrite({
    client: makeClient(transport.fetchImpl),
    request: {
      workOrderId: WO_16376,
      kind: "close",
      patch: { note: "different note" },
      expectedUnitId: null,
    },
    now: NOW,
  });
  assert.equal(closeResult.ok, true);
  assert.equal(closeResult.noop, true);
  assert.equal(posts(transport.calls).length, 0);
});

test("guard: the page served for the wrong work order refuses at parse", async () => {
  const transport = makeTransport({ pages: { [EDIT_URL_16305]: fixture("16376") } });
  await assert.rejects(
    applyWorkOrderWrite({
      client: makeClient(transport.fetchImpl),
      request: { workOrderId: WO_16305, kind: "close", patch: {}, expectedUnitId: UNIT_16305 },
      now: NOW,
    }),
    /action mismatch/,
  );
});

test("guard: a non-GUID work order id never reaches the network", async () => {
  const transport = makeTransport({ pages: {} });
  await assert.rejects(
    applyWorkOrderWrite({
      client: makeClient(transport.fetchImpl),
      request: { workOrderId: "../Delete/123", kind: "close", patch: {}, expectedUnitId: null },
      now: NOW,
    }),
    (error) => error instanceof WorkOrderWriteRefused && /not a GUID/.test(error.message),
  );
  assert.equal(transport.calls.length, 0);
});

test("guard: verify read failing after the POST reports phase=posted", async () => {
  let served = 0;
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "POST") return fakeResponse({ status: 302, headers: { location: url } });
    served += 1;
    if (served > 1) throw new Error("network down");
    return fakeResponse({ status: 200, body: fixture("16305"), url });
  };
  const result = await applyWorkOrderWrite({
    client: makeClient(fetchImpl),
    request: { workOrderId: WO_16305, kind: "close", patch: {}, expectedUnitId: UNIT_16305 },
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.phase, "posted");
  assert.match(result.detail, /verify read failed/);
});

// MARK: - verifyWorkOrderWrite (the reconcile read)

test("verify-only: reports applied when the form already holds every target", async () => {
  const landed = landClose(fixture("16305"), {
    note: "Relit water heater",
    completedBy: "7a2f5c20-42af-4e4e-808e-45bd64ae89c2",
  });
  const transport = makeTransport({ pages: { [EDIT_URL_16305]: landed } });
  const result = await verifyWorkOrderWrite({
    client: makeClient(transport.fetchImpl),
    request: {
      workOrderId: WO_16305,
      kind: "close",
      patch: { note: "Relit water heater" },
      expectedUnitId: UNIT_16305,
    },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.noop, true);
  assert.equal(posts(transport.calls).length, 0, "verify never POSTs");
});

test("verify-only: reports not-landed when the form still holds the old values", async () => {
  const transport = makeTransport({ pages: { [EDIT_URL_16305]: fixture("16305") } });
  const result = await verifyWorkOrderWrite({
    client: makeClient(transport.fetchImpl),
    request: { workOrderId: WO_16305, kind: "close", patch: {}, expectedUnitId: UNIT_16305 },
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(posts(transport.calls).length, 0);
});

// MARK: - Technician resolution

test("resolveTechnician: exact case-insensitive unique match", () => {
  const employees = [
    { name: "Allan Zelaya", personId: "55e3d0ac-69e5-434b-b6fe-23fce4131ffb" },
    { name: "Ben Bloch", personId: "b78d380f-63e9-43c0-aab8-f75b906cb27e" },
  ];
  assert.deepEqual(resolveTechnician(employees, "allan zelaya"), {
    personId: "55e3d0ac-69e5-434b-b6fe-23fce4131ffb",
  });
  assert.match(resolveTechnician(employees, "Al Zelaya").error, /no maintenance employee/);
  assert.match(resolveTechnician(employees, "").error, /empty/);
  const dupes = [...employees, { name: "ben bloch", personId: "ffffffff-0000-0000-0000-000000000000" }];
  assert.match(resolveTechnician(dupes, "Ben Bloch").error, /ambiguous/);
});
