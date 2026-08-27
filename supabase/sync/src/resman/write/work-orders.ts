/**
 * The ResMan work-order WRITER — the only code in the platform that POSTs to
 * ResMan. It applies one queued edit/close from `maintenance_work_order_edits`
 * by replaying the edit form: GET → harvest → mutate an allowlist → POST →
 * re-GET → verify the values actually landed.
 *
 * SAFETY RAILS (each is load-bearing, none is belt-and-braces — see the recon
 * notes in form.ts and docs/Web-API.md):
 *
 *   1. Edits and closes ONLY. Delete and cancel are structurally impossible:
 *      the only URL ever constructed is /WorkOrders/Edit/{id} (asserted again
 *      at parse time against the form's own action), `Status` may only ever be
 *      written as "Completed", and the Cancellation* fields must be empty
 *      before AND after mutation or the write refuses. The rendered page puts
 *      Delete one button above Save and carries the cancellation fields in the
 *      same 48-pair payload — a careless replay could cancel a work order.
 *   2. Field-inventory audit: every named control must be a field the recon
 *      classified (ECHO / MUTABLE). An unknown name means ResMan changed the
 *      form, and the writer refuses to guess ("form drift").
 *   3. Byte diff: after mutation, every pair OUTSIDE the fields this specific
 *      row is allowed to change must be byte-identical to the harvest. A
 *      mutation that leaks past its allowlist aborts before the POST.
 *   4. ObjectID is required by the server but empty in the server-rendered
 *      select (populated async in the browser); its true value rides in
 *      data-selected-value. The writer submits that value and cross-checks it
 *      against the mirror's resman_unit_id for unit-scoped work orders —
 *      a mismatch aborts.
 *   5. No blind retries. The POST is attempted once; whether it LANDED is
 *      decided by re-reading the form, never by the POST's own response. The
 *      flush job only re-queues rows whose verify proves the save did not
 *      land.
 */

import type { ResManClient } from "../client";
import { formURLEncode } from "../client";
import { ResManScrapingError, isResManLoginRedirect } from "../errors";
import {
  type FormControl,
  controlWireValue,
  findControl,
  formatResManDate,
  formatResManDateTime,
  parseWorkOrderEditForm,
  serializeControls,
  setControlValue,
} from "./form";

// MARK: - Field classification (from the 2026-08-26 live capture)

/**
 * Fields the writer echoes back byte-for-byte, never mutates. `StartedByPersonID`
 * has not been observed in a captured form but is wired by WorkOrder.js for
 * some states, so it is classified rather than left to trip the drift guard.
 */
const ECHO_FIELDS = new Set([
  "WorkOrderID", "TempDocObjectID", "UnitNoteID", "SaveAndNew", "SaveAndCopy",
  "_RequiredFields", "SaveAndPrint", "RecurringItemViewModel.TemplateOnly",
  "WorkOrderTemplateID", "PrintLanguageCode", "RedirectUrl", "AssociationObjectID",
  "AssociationObjectType", "ProjectID", "DefaultEmptyGuid", "Number", "PropertyID",
  "ReportedDateTime", "ReportedDateTime_Date", "ReportedDateTime.Time", "DueDate",
  "ObjectID", "ObjectType", "Areas", "InventoryItemID", "ReceivedByPersonID",
  "ReportedBy", "ReportedByPersonID", "Appointment", "Phone", "Pets",
  "WorkOrderCategoryID", "ReportingNotes", "CancellationReasonPickListItemID",
  "CancellationDate", "Priority", "VendorID", "EstimatedCost", "StartedDate",
  "StartedDate_Date", "StartedDate.Time", "StartedByPersonID", "AddRetentionEffortNote",
  // The .Time halves of the two date triples we do write ride along EMPTY —
  // the live capture shows the browser submits them blank even when a time is
  // set (the time lives in the composite field), so they are echo, not mutable.
  "ScheduledDate.Time", "CompletedDate.Time",
]);

/** Fields a write MAY change — the union across both kinds; per-row the set is
 *  narrowed further to exactly what that row's patch touches. */
const MUTABLE_FIELDS = new Set([
  "Description", "AssignedToPersonID", "CompletedNotes",
  "ScheduledDate", "ScheduledDate_Date",
  "Status", "CompletedDate", "CompletedDate_Date", "CompletedByPersonID",
]);

/** ResMan's own limits on Description (data-val-length / data-val-regex). */
export const RESMAN_DESCRIPTION_MAX = 248;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// MARK: - Request/result types

export interface WorkOrderWritePatch {
  /** edit: technician DISPLAY NAME (resolved to a person GUID by the caller). */
  technicianPersonId?: string;
  description?: string;
  completionNotes?: string;
  /** ISO instant; null clears the booking. Absent = untouched. */
  scheduledAt?: string | null;
  /** close: the completion note ("" = leave existing notes alone). */
  note?: string;
  /** close: ISO instant the work was finished. */
  completedAt?: string;
}

export interface WorkOrderWriteRequest {
  workOrderId: string;
  kind: "edit" | "close";
  patch: WorkOrderWritePatch;
  /** Mirror resman_unit_id — cross-checked against the form's ObjectID for
   *  unit-scoped work orders. Null for building/property-scoped rows. */
  expectedUnitId: string | null;
}

/**
 * Where the attempt got to — the flush job's retry decision hangs on this:
 * "preflight" means no POST was sent (safe to re-queue); "posted" means the
 * POST went out but the verify read failed (NOT safe to blindly retry);
 * "verified" means the re-read proved the values landed (or proved they
 * did not).
 */
export type WorkOrderWritePhase = "preflight" | "posted" | "verified";

export interface WorkOrderWriteResult {
  ok: boolean;
  phase: WorkOrderWritePhase;
  /** True when the form already held every target value and no POST was needed. */
  noop: boolean;
  detail: string;
  /** POST response facts, for the log line (302 → landing redirect). */
  postStatus?: number;
}

export class WorkOrderWriteRefused extends Error {
  readonly phase: WorkOrderWritePhase = "preflight";
  constructor(message: string) {
    super(message);
    this.name = "WorkOrderWriteRefused";
  }
}

// MARK: - Harvest helpers

function requireControl(controls: FormControl[], name: string): FormControl {
  const control = findControl(controls, name);
  if (!control) throw new WorkOrderWriteRefused(`form has no ${name} control`);
  return control;
}

function currentStatus(controls: FormControl[]): string {
  return controlWireValue(requireControl(controls, "Status")) ?? "";
}

/** Assert the harvested form is one this writer is allowed to touch at all. */
function preflight(controls: FormControl[], request: WorkOrderWriteRequest): void {
  const workOrderIdField = requireControl(controls, "WorkOrderID");
  if (workOrderIdField.value.toLowerCase() !== request.workOrderId.toLowerCase()) {
    throw new WorkOrderWriteRefused(
      `WorkOrderID field (${workOrderIdField.value}) does not match ${request.workOrderId}`,
    );
  }
  const property = requireControl(controls, "PropertyID");
  if (!GUID_RE.test(property.value)) {
    throw new WorkOrderWriteRefused("PropertyID is not a GUID — wrong page?");
  }

  // Unknown field name = ResMan changed the form. Refuse to guess.
  for (const control of controls) {
    if (!ECHO_FIELDS.has(control.name) && !MUTABLE_FIELDS.has(control.name)) {
      throw new WorkOrderWriteRefused(`form drift: unexpected field ${control.name}`);
    }
  }

  const status = currentStatus(controls);
  if (status === "Cancelled") {
    throw new WorkOrderWriteRefused("work order is Cancelled — the writer never touches those");
  }
  if (status === "Closed" && request.kind === "edit") {
    throw new WorkOrderWriteRefused("work order is Closed — edits after close are office work");
  }

  // Cancellation state must not exist. These fields ride in the same payload
  // as everything else, so a populated one means someone started a cancel in
  // the UI — nothing we should replay.
  for (const name of ["CancellationReasonPickListItemID", "CancellationDate"]) {
    const value = controlWireValue(requireControl(controls, name)) ?? "";
    if (value !== "") {
      throw new WorkOrderWriteRefused(`work order carries cancellation state (${name})`);
    }
  }

  // ObjectID: required by the server, async-populated in the browser, value in
  // data-selected-value. Without it a POST may sever the work order's location.
  const objectId = requireControl(controls, "ObjectID");
  const objectIdValue = controlWireValue(objectId) ?? "";
  if (!GUID_RE.test(objectIdValue)) {
    throw new WorkOrderWriteRefused("ObjectID (location) missing from the form — refusing to save without it");
  }
  const objectType = controlWireValue(requireControl(controls, "ObjectType")) ?? "";
  if (request.expectedUnitId && objectType === "Unit" && objectIdValue.toLowerCase() !== request.expectedUnitId.toLowerCase()) {
    throw new WorkOrderWriteRefused(
      `ObjectID ${objectIdValue} does not match the mirror's unit ${request.expectedUnitId}`,
    );
  }
}

// MARK: - Mutation

interface MutationPlan {
  /** Field names this row is allowed to change — the byte-diff exemption set. */
  allowed: Set<string>;
  /** Human-readable target values for the verify step. */
  targets: Map<string, string>;
}

function sanitizeDescription(raw: string): string {
  // ResMan rejects '<' and '>' (data-val-regex) and caps at 248.
  return raw.replace(/[<>]/g, "").slice(0, RESMAN_DESCRIPTION_MAX);
}

/** Apply the patch to the parsed controls. Returns what changed. */
function mutate(controls: FormControl[], request: WorkOrderWriteRequest, now: Date): MutationPlan {
  const allowed = new Set<string>();
  const targets = new Map<string, string>();
  const { patch } = request;

  const set = (name: string, value: string): void => {
    const control = requireControl(controls, name);
    if ((controlWireValue(control) ?? "") === value) return; // already there — not a change
    setControlValue(control, value);
    allowed.add(name);
    targets.set(name, value);
  };

  if (request.kind === "edit") {
    if (patch.description !== undefined) {
      const description = requireControl(controls, "Description");
      if (description.kind === "input" && description.type === "hidden") {
        // ResMan renders Description locked (hidden) on some work orders
        // (observed on a make-ready). The UI would not allow this edit; neither do we.
        throw new WorkOrderWriteRefused("Description is locked by ResMan on this work order");
      }
      set("Description", sanitizeDescription(patch.description));
    }
    if (patch.technicianPersonId !== undefined) {
      if (!GUID_RE.test(patch.technicianPersonId)) {
        throw new WorkOrderWriteRefused("technician did not resolve to a person GUID");
      }
      set("AssignedToPersonID", patch.technicianPersonId);
    }
    if (patch.completionNotes !== undefined) {
      set("CompletedNotes", patch.completionNotes);
    }
    if (patch.scheduledAt !== undefined) {
      if (patch.scheduledAt === null) {
        set("ScheduledDate", "");
        set("ScheduledDate_Date", "");
      } else {
        const when = new Date(patch.scheduledAt);
        if (Number.isNaN(when.getTime())) {
          throw new WorkOrderWriteRefused(`scheduledAt is not a date: ${patch.scheduledAt}`);
        }
        set("ScheduledDate", formatResManDateTime(when));
        set("ScheduledDate_Date", formatResManDate(when));
      }
    }
  } else {
    // close — replays what the page's own completedClosed() does: stamp the
    // completion date, set Status=Completed, and fill CompletedBy from the
    // assignee when empty (ResMan credits the assignee, not the session).
    const completedAt = patch.completedAt ? new Date(patch.completedAt) : now;
    if (Number.isNaN(completedAt.getTime())) {
      throw new WorkOrderWriteRefused(`completedAt is not a date: ${patch.completedAt}`);
    }
    // A work order the office already Closed is out of the technician's hands
    // entirely — the close (and its note) is done history, not ours to amend.
    const status = currentStatus(controls);
    if (status === "Closed") {
      return { allowed, targets };
    }
    // One that is already Completed keeps its original completion stamp —
    // a retried close must not move history — but a corrected note may land.
    const alreadyDone = status === "Completed";
    if (!alreadyDone) {
      set("CompletedDate", formatResManDateTime(completedAt));
      set("CompletedDate_Date", formatResManDate(completedAt));
      set("Status", "Completed"); // setControlValue proves the option exists
    }
    if (patch.note) {
      set("CompletedNotes", patch.note);
    }
    const completedBy = requireControl(controls, "CompletedByPersonID");
    if ((controlWireValue(completedBy) ?? "") === "") {
      const assignee = controlWireValue(requireControl(controls, "AssignedToPersonID")) ?? "";
      if (assignee !== "") set("CompletedByPersonID", assignee);
    }
  }

  // The one Status value this writer may ever produce.
  const statusAfter = currentStatus(controls);
  if (allowed.has("Status") && statusAfter !== "Completed") {
    throw new WorkOrderWriteRefused(`refusing to write Status=${statusAfter}`);
  }

  return { allowed, targets };
}

/** Byte-diff: every pair outside `allowed` must match the harvest exactly. */
function assertOnlyAllowedChanged(
  before: Array<[string, string]>,
  after: Array<[string, string]>,
  allowed: Set<string>,
): void {
  if (before.length !== after.length) {
    throw new WorkOrderWriteRefused(
      `mutation changed the pair count (${before.length} → ${after.length})`,
    );
  }
  for (let i = 0; i < before.length; i += 1) {
    const [nameBefore, valueBefore] = before[i];
    const [nameAfter, valueAfter] = after[i];
    if (nameBefore !== nameAfter) {
      throw new WorkOrderWriteRefused(`mutation reordered fields (${nameBefore} → ${nameAfter})`);
    }
    if (valueBefore !== valueAfter && !allowed.has(nameBefore)) {
      throw new WorkOrderWriteRefused(`mutation leaked into ${nameBefore}`);
    }
  }
}

// MARK: - Verify

/** Free-text fields whose CONTENT stays out of logs and last_error (AGENTS.md:
 *  keep request bodies out of logs — notes can carry unit/resident details). */
const FREE_TEXT_FIELDS = new Set(["Description", "CompletedNotes", "ReportingNotes"]);

/** Compare a fresh harvest against the mutation's targets. */
function verifyTargets(controls: FormControl[], targets: Map<string, string>): string[] {
  const mismatches: string[] = [];
  for (const [name, expected] of targets) {
    const control = findControl(controls, name);
    const actual = control ? (controlWireValue(control) ?? "") : null;
    if (actual === expected) continue;
    if (FREE_TEXT_FIELDS.has(name)) {
      mismatches.push(
        `${name}: expected ${expected.length} chars, got ` +
          (actual === null ? "(missing)" : `${actual.length}`),
      );
    } else {
      mismatches.push(
        `${name}: expected ${JSON.stringify(expected)}, got ` +
          (actual === null ? "(missing)" : JSON.stringify(actual)),
      );
    }
  }
  return mismatches;
}

// MARK: - The write

const EDIT_PATH = "/WorkOrders/Edit/";

export interface ApplyWorkOrderWriteParams {
  client: ResManClient;
  request: WorkOrderWriteRequest;
  log?: (message: string) => void;
  /** Injected for tests. */
  now?: () => Date;
}

async function fetchEditForm(
  client: ResManClient,
  base: string,
  workOrderId: string,
): Promise<FormControl[]> {
  const url = `${base}${EDIT_PATH}${workOrderId}`;
  const response = await client.data(
    { url, method: "GET", headers: { referer: base } },
    `GET work-order edit ${workOrderId}`,
  );
  if (isResManLoginRedirect(response.finalUrl)) throw ResManScrapingError.authenticationRequired();
  if (response.status !== 200) {
    throw ResManScrapingError.networkError(new Error(`HTTP ${response.status} for ${url}`));
  }
  return parseWorkOrderEditForm(response.text, workOrderId).controls;
}

/**
 * Apply one edit/close to ResMan. Throws `WorkOrderWriteRefused` (phase
 * preflight — nothing was sent) or `ResManScrapingError` for transport
 * failures; the caller maps phases to queue-row outcomes.
 */
export async function applyWorkOrderWrite(params: ApplyWorkOrderWriteParams): Promise<WorkOrderWriteResult> {
  const { client, request } = params;
  const log = params.log ?? (() => {});
  const now = params.now ?? (() => new Date());
  if (request.kind !== "edit" && request.kind !== "close") {
    throw new WorkOrderWriteRefused(`unknown write kind ${String(request.kind)}`);
  }
  if (!GUID_RE.test(request.workOrderId)) {
    throw new WorkOrderWriteRefused(`work order id is not a GUID: ${request.workOrderId}`);
  }
  const base = client.configuration.consumerStartUrl.replace(/\/$/, "");

  // 1. Harvest.
  const controls = await fetchEditForm(client, base, request.workOrderId);
  preflight(controls, request);
  const before = serializeControls(controls);

  // 2. Mutate + diff.
  const { allowed, targets } = mutate(controls, request, now());
  if (allowed.size === 0) {
    log(`[wo-write] ${request.workOrderId} ${request.kind}: form already holds every target — no-op`);
    return { ok: true, phase: "verified", noop: true, detail: "already applied" };
  }
  const after = serializeControls(controls);
  assertOnlyAllowedChanged(before, after, allowed);

  // 3. POST — one attempt, never retried here. The form submits natively
  // (no antiforgery token on this page), so the payload is exactly the
  // successful controls in document order.
  const url = `${base}${EDIT_PATH}${request.workOrderId}`;
  const postResponse = await client.data(
    {
      url,
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: url,
        origin: base,
      },
      body: formURLEncode(after),
    },
    `POST work-order ${request.kind} ${request.workOrderId}`,
  );
  log(
    `[wo-write] ${request.workOrderId} ${request.kind}: POST → ${postResponse.status}` +
      `${postResponse.headers.get("location") ? ` (${postResponse.headers.get("location")})` : ""}`,
  );
  if (isResManLoginRedirect(postResponse.headers.get("location") ?? "")) {
    // Session died between harvest and save — nothing was written.
    throw ResManScrapingError.authenticationRequired();
  }

  // 4. Verify by re-reading, never by trusting the POST's own response.
  let fresh: FormControl[];
  try {
    fresh = await fetchEditForm(client, base, request.workOrderId);
  } catch (error) {
    return {
      ok: false,
      phase: "posted",
      noop: false,
      postStatus: postResponse.status,
      detail: `verify read failed after POST: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const mismatches = verifyTargets(fresh, targets);
  if (mismatches.length > 0) {
    return {
      ok: false,
      phase: "verified",
      noop: false,
      postStatus: postResponse.status,
      detail: `save did not land: ${mismatches.join("; ")}`,
    };
  }
  return { ok: true, phase: "verified", noop: false, postStatus: postResponse.status, detail: "verified" };
}

/**
 * Verify-only reconcile for a row whose earlier attempt POSTed but could not
 * confirm: re-read the form and report whether the targets are present now.
 */
export async function verifyWorkOrderWrite(params: ApplyWorkOrderWriteParams): Promise<WorkOrderWriteResult> {
  const { client, request } = params;
  const now = params.now ?? (() => new Date());
  const base = client.configuration.consumerStartUrl.replace(/\/$/, "");
  const controls = await fetchEditForm(client, base, request.workOrderId);
  preflight(controls, request);
  const { allowed } = mutate(controls, request, now());
  if (allowed.size === 0) {
    return { ok: true, phase: "verified", noop: true, detail: "already applied" };
  }
  return { ok: false, phase: "verified", noop: false, detail: "targets not present on re-read" };
}
