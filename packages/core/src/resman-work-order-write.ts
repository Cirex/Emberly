/**
 * The ResMan work-order write ENGINE — shared verbatim by the sync worker
 * (service-account flush of the office-side queue) and the maintenance app
 * (direct on-device writes under the technician's own ResMan session).
 *
 * The mechanism is a form replay against the page ResMan itself serves:
 * GET /WorkOrders/Edit/{id} → harvest every control → mutate an allowlisted
 * few → POST the whole set back in document order → RE-READ the form and
 * verify the values landed. Success is only ever decided by the re-read —
 * never by the POST's own response, which one runtime can't even observe
 * (React Native's fetch auto-follows the redirect).
 *
 * SAFETY RAILS (each is load-bearing — recon 2026-08-26, fixtures in
 * supabase/sync/tests/fixtures/):
 *   1. Edits and closes ONLY. The only URL ever built is /WorkOrders/Edit/{id}
 *      (re-asserted against the form's own action at parse time), `Status`
 *      may only ever be written as "Completed", and the Cancellation* fields
 *      must be empty before AND after mutation or the write refuses. Delete
 *      is one button above Save and cancellation rides in the same payload.
 *   2. Field-inventory audit: every named control must be a field the recon
 *      classified. An unknown name means ResMan changed the form — refuse.
 *   3. Byte diff: after mutation, every pair OUTSIDE the fields this specific
 *      request may change must be byte-identical to the harvest.
 *   4. ObjectID (required server-side, async-populated in the browser, its
 *      value riding in data-selected-value) is submitted from the page's own
 *      attribute and optionally cross-checked against the caller's mirror.
 *   5. No blind retries here: one POST per call; callers decide retry policy
 *      from the reported phase.
 *
 * Parsing is deliberately faithful to what the BROWSER would submit:
 *   - Attribute values can contain a raw `>` (Description's data-val-regex
 *     message does) — tags are walked with a quote-aware scanner, never a
 *     naive regex, which silently DROPS the Description control.
 *   - `<option>Submitted</option>` has no value attribute; HTML submits the
 *     option TEXT. Status/Priority rely on this.
 *   - Combobox selects carry the current value in `data-selected-value`; the
 *     page's own JS re-populates their options and selects that value, so
 *     when the attribute is present it IS the wire value.
 *   - Areas and Pets are `multiple` selects: one pair per selected option and
 *     NOTHING when none is selected.
 *   - The ASP.NET checkbox pair (checkbox "true" + hidden "false") submits
 *     only the hidden "false" while unchecked.
 *   - Dates are property-local wall time in ResMan's three spellings.
 */

import { isResManLoginRedirectUrl, resManFormURLEncode } from "./resman-staff-auth";
import { technicianDisplayName } from "./work-orders";

// MARK: - Errors

/** The harvested page is not the expected edit form (or failed to parse). */
export class ResManFormParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResManFormParseError";
  }
}

/** A guard said no. Deterministic — retrying the same request cannot help. */
export class WorkOrderWriteRefused extends Error {
  readonly phase = "preflight" as const;
  constructor(message: string) {
    super(message);
    this.name = "WorkOrderWriteRefused";
  }
}

/** The ResMan session is gone — the caller must re-authenticate. */
export class ResManSessionExpiredError extends Error {
  constructor() {
    super("ResMan session expired");
    this.name = "ResManSessionExpiredError";
  }
}

// MARK: - Form model

export type FormControlKind = "input" | "select" | "textarea";

export interface FormOption {
  /** What this option would submit: value attribute, or the TEXT when absent. */
  submitValue: string;
  selected: boolean;
}

export interface FormControl {
  name: string;
  kind: FormControlKind;
  /** input `type`, lowercased; "" for select/textarea. */
  type: string;
  /** input value attr / textarea inner text (both HTML-decoded). */
  value: string;
  /** `data-selected-value` on combobox selects; null when absent. */
  dataSelectedValue: string | null;
  checked: boolean;
  disabled: boolean;
  /** select `multiple` — Areas and Pets. */
  multiple: boolean;
  options: FormOption[];
}

export interface ParsedWorkOrderEditForm {
  /** The form's action attribute, HTML-decoded (e.g. /WorkOrders/Edit/{id}). */
  action: string;
  /** Named controls in document order — the order the wire payload uses. */
  controls: FormControl[];
}

// MARK: - HTML scanning primitives

/** Decode the entities ResMan uses in attributes/textarea bodies. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

interface RawTag {
  /** Tag name, lowercased. */
  tag: string;
  attrs: Map<string, string>;
  /** Index just past the closing `>` of the opening tag. */
  end: number;
  selfClosed: boolean;
}

/**
 * Parse one opening tag starting at `start` (which must point at `<`).
 * Quote-aware: a `>` inside a quoted attribute value does not end the tag.
 * Returns null when the slice is not a well-formed opening tag.
 */
function parseTag(html: string, start: number): RawTag | null {
  let i = start + 1;
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9]*/.exec(html.slice(i, i + 20));
  if (!nameMatch) return null;
  const tag = nameMatch[0].toLowerCase();
  i += nameMatch[0].length;

  const attrs = new Map<string, string>();
  let selfClosed = false;
  for (;;) {
    // Skip whitespace.
    while (i < html.length && /\s/.test(html[i])) i += 1;
    if (i >= html.length) return null;
    const ch = html[i];
    if (ch === ">") return { tag, attrs, end: i + 1, selfClosed };
    if (ch === "/" && html[i + 1] === ">") {
      selfClosed = true;
      return { tag, attrs, end: i + 2, selfClosed };
    }
    // Attribute name.
    const attrMatch = /^[^\s=/>]+/.exec(html.slice(i, i + 200));
    if (!attrMatch) return null;
    const attrName = attrMatch[0].toLowerCase();
    i += attrMatch[0].length;
    while (i < html.length && /\s/.test(html[i])) i += 1;
    if (html[i] !== "=") {
      // Boolean attribute (checked, disabled, selected).
      if (!attrs.has(attrName)) attrs.set(attrName, "");
      continue;
    }
    i += 1;
    while (i < html.length && /\s/.test(html[i])) i += 1;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      if (close === -1) return null;
      if (!attrs.has(attrName)) attrs.set(attrName, decodeEntities(html.slice(i + 1, close)));
      i = close + 1;
    } else {
      const unquoted = /^[^\s>]*/.exec(html.slice(i, i + 500));
      if (!attrs.has(attrName)) attrs.set(attrName, decodeEntities(unquoted?.[0] ?? ""));
      i += unquoted?.[0].length ?? 0;
    }
  }
}

/** Find the next opening tag of one of `names` at/after `from`. */
function nextTag(
  html: string,
  from: number,
  names: readonly string[],
): { tag: RawTag; start: number } | null {
  let i = from;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) return null;
    const parsed = parseTag(html, lt);
    if (parsed && names.includes(parsed.tag)) return { tag: parsed, start: lt };
    i = lt + 1;
  }
  return null;
}

// MARK: - Form extraction

const CONTROL_TAGS = ["input", "select", "textarea", "button", "form"] as const;

/**
 * Locate `NewEditWorkOrderForm` in a full page and parse its named controls in
 * document order. Throws `ResManFormParseError` when the form is missing or
 * the action is not the expected `/WorkOrders/Edit/{workOrderId}` — the URL
 * assertion is deliberately here, at parse time, so a page that is not the
 * expected edit form can never be serialized at all.
 */
export function parseWorkOrderEditForm(html: string, workOrderId: string): ParsedWorkOrderEditForm {
  const marker = html.indexOf('id="NewEditWorkOrderForm"');
  if (marker === -1) {
    throw new ResManFormParseError("NewEditWorkOrderForm not found in page");
  }
  const formStart = html.lastIndexOf("<form", marker);
  if (formStart === -1) {
    throw new ResManFormParseError("NewEditWorkOrderForm has no <form> tag");
  }
  const formTag = parseTag(html, formStart);
  if (!formTag || formTag.tag !== "form") {
    throw new ResManFormParseError("NewEditWorkOrderForm form tag failed to parse");
  }
  const action = formTag.attrs.get("action") ?? "";
  const expectedAction = `/WorkOrders/Edit/${workOrderId}`;
  if (action !== expectedAction) {
    throw new ResManFormParseError(
      `edit form action mismatch: expected ${expectedAction}, got ${action || "(empty)"}`,
    );
  }
  if ((formTag.attrs.get("method") ?? "").toLowerCase() !== "post") {
    throw new ResManFormParseError("edit form method is not post");
  }
  const formEnd = html.indexOf("</form>", formTag.end);
  if (formEnd === -1) {
    throw new ResManFormParseError("edit form is never closed");
  }

  const controls: FormControl[] = [];
  let i = formTag.end;
  while (i < formEnd) {
    const found = nextTag(html, i, CONTROL_TAGS);
    if (!found || found.start >= formEnd) break;
    const { tag } = found;
    i = tag.end;
    if (tag.tag === "form") {
      throw new ResManFormParseError("nested <form> inside NewEditWorkOrderForm");
    }
    const name = tag.attrs.get("name");

    if (tag.tag === "select") {
      const close = html.indexOf("</select>", tag.end);
      if (close === -1 || close > formEnd) {
        throw new ResManFormParseError(`unclosed <select ${name ?? "?"}>`);
      }
      const inner = html.slice(tag.end, close);
      i = close + "</select>".length;
      if (!name) continue;
      const options: FormOption[] = [];
      let oi = 0;
      while (oi < inner.length) {
        const opt = nextTag(inner, oi, ["option"]);
        if (!opt) break;
        const optClose = inner.indexOf("</option>", opt.tag.end);
        const text = decodeEntities(
          inner.slice(opt.tag.end, optClose === -1 ? inner.length : optClose).trim(),
        );
        const valueAttr = opt.tag.attrs.get("value");
        options.push({
          // HTML: an option without a value attribute submits its text.
          submitValue: valueAttr !== undefined ? valueAttr : text,
          selected: opt.tag.attrs.has("selected"),
        });
        oi = optClose === -1 ? inner.length : optClose + "</option>".length;
      }
      controls.push({
        name,
        kind: "select",
        type: "",
        value: "",
        dataSelectedValue: tag.attrs.get("data-selected-value") ?? null,
        checked: false,
        disabled: tag.attrs.has("disabled"),
        multiple: tag.attrs.has("multiple"),
        options,
      });
      continue;
    }

    if (tag.tag === "textarea") {
      const close = html.indexOf("</textarea>", tag.end);
      if (close === -1 || close > formEnd) {
        throw new ResManFormParseError(`unclosed <textarea ${name ?? "?"}>`);
      }
      const inner = html.slice(tag.end, close);
      i = close + "</textarea>".length;
      if (!name) continue;
      controls.push({
        name,
        kind: "textarea",
        type: "",
        // Browsers drop one leading newline after <textarea>; ResMan doesn't
        // render one, but be faithful anyway.
        value: decodeEntities(inner.replace(/^\r?\n/, "")),
        dataSelectedValue: null,
        checked: false,
        disabled: tag.attrs.has("disabled"),
        multiple: false,
        options: [],
      });
      continue;
    }

    if (tag.tag === "button") continue; // Save/Delete/Email — never serialized.

    // input
    if (!name) continue;
    const type = (tag.attrs.get("type") ?? "text").toLowerCase();
    controls.push({
      name,
      kind: "input",
      type,
      value: tag.attrs.get("value") ?? "",
      dataSelectedValue: tag.attrs.get("data-selected-value") ?? null,
      checked: tag.attrs.has("checked"),
      disabled: tag.attrs.has("disabled"),
      multiple: false,
      options: [],
    });
  }

  if (controls.length === 0) {
    throw new ResManFormParseError("edit form has no named controls");
  }
  return { action, controls };
}

// MARK: - Serialization (what the browser would submit)

const NEVER_SUBMITTED_INPUT_TYPES = new Set(["submit", "button", "reset", "file", "image"]);

/**
 * The wire values of one control in document position: [] when the control is
 * not a "successful control" (disabled, unchecked box, unselected multiple),
 * one entry for everything else, several for a multi-select.
 */
export function controlWirePairs(control: FormControl): string[] {
  if (control.disabled) return [];
  if (control.kind === "input") {
    if (NEVER_SUBMITTED_INPUT_TYPES.has(control.type)) return [];
    if ((control.type === "checkbox" || control.type === "radio") && !control.checked) return [];
    return [control.value];
  }
  if (control.kind === "textarea") return [control.value];
  // select
  if (control.multiple) {
    // One pair per selected option, NOTHING when none — a first-option
    // default here would invent an Area/Pet on every write.
    return control.options.filter((option) => option.selected).map((option) => option.submitValue);
  }
  // Combobox: when data-selected-value is present it is authoritative — the
  // page's JS re-populates the options and selects exactly this value, even
  // where the server also rendered an (unselected) option list.
  if (control.dataSelectedValue !== null) return [control.dataSelectedValue];
  const selected = control.options.find((option) => option.selected);
  if (selected) return [selected.submitValue];
  if (control.options.length > 0) {
    // No explicit selection: a single <select> submits its first option
    // (always the empty option on this form).
    return [control.options[0].submitValue];
  }
  return [""];
}

/**
 * The single wire value of a non-multiple control — what the guards and the
 * verify step compare. Refuses multi-selects: none of them is ever a guard or
 * mutation target, and collapsing several pairs to one would hide drift.
 */
export function controlWireValue(control: FormControl): string | null {
  if (control.multiple) {
    throw new ResManFormParseError(`${control.name} is a multi-select`);
  }
  const pairs = controlWirePairs(control);
  return pairs.length === 0 ? null : pairs[0];
}

/** Ordered name/value pairs — the exact POST body content, pre-encoding. */
export function serializeControls(controls: readonly FormControl[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const control of controls) {
    for (const value of controlWirePairs(control)) pairs.push([control.name, value]);
  }
  return pairs;
}

// MARK: - Mutation helpers

/** The single control with this name, or null. Throws on duplicates EXCEPT the
 *  ASP.NET checkbox pair (checkbox + hidden false), where the checkbox wins. */
export function findControl(controls: readonly FormControl[], name: string): FormControl | null {
  const matches = controls.filter((control) => control.name === name);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const checkbox = matches.find((control) => control.type === "checkbox");
  if (checkbox && matches.length === 2) return checkbox;
  throw new ResManFormParseError(`duplicate form control: ${name}`);
}

/**
 * Point a control at a new wire value, the way the page's own JS would:
 * inputs/textareas get the value; combobox selects (data-selected-value
 * present, or no options) get `data-selected-value`; option-backed selects
 * move `selected` to the matching option (throwing when no option matches —
 * never invent an option). Multi-selects refuse.
 */
export function setControlValue(control: FormControl, value: string): void {
  if (control.multiple) {
    throw new ResManFormParseError(`refusing to mutate multi-select ${control.name}`);
  }
  if (control.kind === "input" || control.kind === "textarea") {
    control.value = value;
    return;
  }
  if (control.dataSelectedValue !== null || control.options.length === 0) {
    // Combobox: the wire value comes from data-selected-value (see
    // controlWirePairs), so that is what a mutation must move.
    control.dataSelectedValue = value;
    return;
  }
  const target = control.options.find((option) => option.submitValue === value);
  if (!target) {
    throw new ResManFormParseError(`select ${control.name} has no option ${JSON.stringify(value)}`);
  }
  for (const option of control.options) option.selected = option === target;
}

// MARK: - ResMan date spellings

/**
 * The property's wall-clock timezone. Work-order dates are typed and shown as
 * local Memphis time in ResMan, so that is what a write must say — an ISO
 * instant from a device is converted, never truncated.
 */
export const RESMAN_PROPERTY_TIME_ZONE = "America/Chicago";

function parts(date: Date, timeZone: string): Record<string, string> {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  } catch {
    // A runtime without timezone data (older Hermes) falls back to device-local
    // wall time — technicians are on property-local time, so this degrades to
    // the right answer where it matters.
    formatter = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  }
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) out[part.type] = part.value;
  return out;
}

/** `8/26/2026 7:43:00 PM` — the composite field: no leading zeros on M/D/h. */
export function formatResManDateTime(date: Date, timeZone = RESMAN_PROPERTY_TIME_ZONE): string {
  const p = parts(date, timeZone);
  const month = String(Number(p.month));
  const day = String(Number(p.day));
  const hour = String(Number(p.hour));
  return `${month}/${day}/${p.year} ${hour}:${p.minute}:${p.second} ${p.dayPeriod}`;
}

/** `08/26/2026` — the `_Date` twin: zero-padded. */
export function formatResManDate(date: Date, timeZone = RESMAN_PROPERTY_TIME_ZONE): string {
  const p = parts(date, timeZone);
  return `${p.month}/${p.day}/${p.year}`;
}

// MARK: - Field classification (from the 2026-08-26 live capture)

/**
 * Fields the writer echoes back byte-for-byte, never mutates.
 * `StartedByPersonID` has not been observed in a captured form but is wired
 * by WorkOrder.js for some states, so it is classified rather than left to
 * trip the drift guard.
 */
const ECHO_FIELDS = new Set([
  "WorkOrderID",
  "TempDocObjectID",
  "UnitNoteID",
  "SaveAndNew",
  "SaveAndCopy",
  "_RequiredFields",
  "SaveAndPrint",
  "RecurringItemViewModel.TemplateOnly",
  "WorkOrderTemplateID",
  "PrintLanguageCode",
  "RedirectUrl",
  "AssociationObjectID",
  "AssociationObjectType",
  "ProjectID",
  "DefaultEmptyGuid",
  "Number",
  "PropertyID",
  "ReportedDateTime",
  "ReportedDateTime_Date",
  "ReportedDateTime.Time",
  "DueDate",
  "ObjectID",
  "ObjectType",
  "Areas",
  "InventoryItemID",
  "ReceivedByPersonID",
  "ReportedBy",
  "ReportedByPersonID",
  "Appointment",
  "Phone",
  "Pets",
  "WorkOrderCategoryID",
  "ReportingNotes",
  "CancellationReasonPickListItemID",
  "CancellationDate",
  "Priority",
  "VendorID",
  "EstimatedCost",
  "StartedDate",
  // Synthesized by the writer (see resolveWorkOrderLocationName): the display
  // text the ObjectID combobox posts. ResMan persists its denormalized
  // ObjectName from THIS field on every save — omit it and the work order's
  // unit/building name blanks in every list and report (verified live on
  // WOs 14627 and 16376, 2026-08-27).
  "Location",
  "StartedDate_Date",
  "StartedDate.Time",
  "StartedByPersonID",
  "AddRetentionEffortNote",
  // The .Time halves of the two date triples we do write ride along as
  // harvested — the composite field carries the authoritative value.
  "ScheduledDate.Time",
  "CompletedDate.Time",
]);

/** Fields a write MAY change — the union across both kinds; per-request the
 *  set is narrowed further to exactly what that request's patch touches. */
const MUTABLE_FIELDS = new Set([
  "Description",
  "AssignedToPersonID",
  "CompletedNotes",
  "ScheduledDate",
  "ScheduledDate_Date",
  "Status",
  "CompletedDate",
  "CompletedDate_Date",
  "CompletedByPersonID",
]);

/** ResMan's own limits on Description (data-val-length / data-val-regex). */
export const RESMAN_DESCRIPTION_MAX = 248;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// MARK: - Request/result types

export interface WorkOrderWritePatch {
  /** edit: assignee as a resolved ResMan person GUID… */
  technicianPersonId?: string;
  /** …or as a display name, resolved via the request's `resolveTechnician`
   *  hook once the form (and its PropertyID) has been harvested. */
  technicianName?: string;
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
   *  unit-scoped work orders. Null skips the cross-check (the page's own
   *  data-selected-value is still required and submitted). */
  expectedUnitId: string | null;
}

/**
 * Where the attempt got to — retry policy hangs on this: "preflight" means no
 * POST was sent (safe to retry); "posted" means the POST went out but the
 * verify read failed (NOT safe to blindly retry); "verified" means the
 * re-read proved the values landed (or proved they did not).
 */
export type WorkOrderWritePhase = "preflight" | "posted" | "verified";

export interface WorkOrderWriteResult {
  ok: boolean;
  phase: WorkOrderWritePhase;
  /** True when the form already held every target value and no POST was needed. */
  noop: boolean;
  detail: string;
  /** POST response facts, for the log line. Runtimes that auto-follow report
   *  the post-redirect status (200). */
  postStatus?: number;
}

// MARK: - Location display name

/**
 * The edit page server-renders `var workOrderableObjects = [{ObjectID,
 * ObjectType, Name, …}]` — the same list the page's own combobox uses to show
 * the Location text. Resolve the display name for the harvested ObjectID from
 * it. Null when the page carries no entry for that id.
 */
export function resolveWorkOrderLocationName(html: string, objectId: string): string | null {
  const pattern = new RegExp(
    '\\{"ObjectID":"' +
      objectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      '","ObjectType":"[^"]*","Name":"((?:[^"\\\\]|\\\\.)*)"',
    "i",
  );
  const match = pattern.exec(html);
  if (!match) return null;
  return match[1].replace(/\\(.)/g, "$1");
}

/**
 * Insert the synthetic `Location` input the browser's combobox would submit,
 * positioned directly after the ObjectID select the way the real input sits
 * in the DOM. Must run BEFORE the byte-diff baseline is taken.
 */
function synthesizeLocationControl(controls: FormControl[], name: string): void {
  const index = controls.findIndex((control) => control.name === "ObjectID");
  const location: FormControl = {
    name: "Location",
    kind: "input",
    type: "text",
    value: name,
    dataSelectedValue: null,
    checked: false,
    disabled: false,
    multiple: false,
    options: [],
  };
  controls.splice(index + 1, 0, location);
}

// MARK: - Transport interface

export interface ResManPageResponse {
  status: number;
  /** The URL the response ultimately came from (after any redirects). */
  finalUrl: string;
  text: string;
}

/**
 * The transport the engine writes through. Implementations own cookies and
 * redirect behavior: the node client follows manually with a cookie jar; the
 * app's fetch auto-follows with the native cookie store. Both MUST surface
 * the final URL so the engine can detect a login redirect.
 */
export interface ResManPageHttp {
  getPage(url: string): Promise<ResManPageResponse>;
  postForm(url: string, body: string, referer: string): Promise<ResManPageResponse>;
}

// MARK: - Harvest helpers and guards

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
    throw new WorkOrderWriteRefused(
      "ObjectID (location) missing from the form — refusing to save without it",
    );
  }
  const objectType = controlWireValue(requireControl(controls, "ObjectType")) ?? "";
  if (
    request.expectedUnitId &&
    objectType === "Unit" &&
    objectIdValue.toLowerCase() !== request.expectedUnitId.toLowerCase()
  ) {
    throw new WorkOrderWriteRefused(
      `ObjectID ${objectIdValue} does not match the mirror's unit ${request.expectedUnitId}`,
    );
  }
}

// MARK: - Mutation

interface MutationPlan {
  /** Field names this request may change — the byte-diff exemption set. */
  allowed: Set<string>;
  /** Target values for the verify step. */
  targets: Map<string, string>;
}

function sanitizeDescription(raw: string): string {
  // ResMan rejects '<' and '>' (data-val-regex) and caps at 248.
  return raw.replace(/[<>]/g, "").slice(0, RESMAN_DESCRIPTION_MAX);
}

/** Apply the patch to the parsed controls. Returns what changed. The caller
 *  must have resolved `technicianName` into `technicianPersonId` already. */
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

  /** The plain field edits — applied for BOTH kinds, so a close can carry an
   *  accompanying edit (typed notes, a reassignment) as ONE ResMan update
   *  instead of two form replays. */
  const applyEditFields = (): void => {
    if (patch.description !== undefined) {
      const description = requireControl(controls, "Description");
      if (description.kind === "input" && description.type === "hidden") {
        // ResMan renders Description locked (hidden) on some work orders
        // (observed on a make-ready). The UI would not allow this edit;
        // neither do we.
        throw new WorkOrderWriteRefused("Description is locked by ResMan on this work order");
      }
      set("Description", sanitizeDescription(patch.description));
    }
    if (patch.technicianPersonId !== undefined) {
      // "" clears the assignee — ResMan's own combobox carries an empty first
      // option, and an unassigned work order is a legal state. Anything else
      // must be a real person GUID.
      if (patch.technicianPersonId !== "" && !GUID_RE.test(patch.technicianPersonId)) {
        throw new WorkOrderWriteRefused("technician did not resolve to a person GUID");
      }
      set("AssignedToPersonID", patch.technicianPersonId);
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
  };

  if (request.kind === "edit") {
    applyEditFields();
    if (patch.completionNotes !== undefined) {
      set("CompletedNotes", patch.completionNotes);
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
    // entirely — the close (and its folded edits) is done history, not ours.
    const status = currentStatus(controls);
    if (status === "Closed") {
      return { allowed, targets };
    }
    // Folded edit fields FIRST — so a reassignment lands before the
    // CompletedBy fill reads the assignee.
    applyEditFields();
    // One that is already Completed keeps its original completion stamp —
    // a retried close must not move history — but a corrected note may land.
    const alreadyDone = status === "Completed";
    if (!alreadyDone) {
      set("CompletedDate", formatResManDateTime(completedAt));
      set("CompletedDate_Date", formatResManDate(completedAt));
      set("Status", "Completed"); // setControlValue proves the option exists
    }
    // The close's own note wins over folded typed notes — it is the newer
    // statement; typed notes apply when the close carried none.
    if (patch.note) {
      set("CompletedNotes", patch.note);
    } else if (patch.completionNotes !== undefined) {
      set("CompletedNotes", patch.completionNotes);
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

/** Free-text fields whose CONTENT stays out of logs and error strings (notes
 *  can carry unit/resident details). */
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

// MARK: - Employee resolution

export interface ResManEmployee {
  name: string;
  personId: string;
}

/** Path + query for the assignee roster — the same call the edit page's own
 *  combobox makes (WorkOrder.js `getEmployees()`). Relative to the consumer
 *  base URL. */
export function employeeListPath(propertyId: string): string {
  return `/Employees/EmployeeList?propertyID=${encodeURIComponent(propertyId)}&employeeType=Maintenance`;
}

/** Parse the EmployeeList JSON (an array of { Name, PersonID, … }). */
export function parseEmployeeList(json: unknown): ResManEmployee[] {
  if (!Array.isArray(json)) {
    throw new ResManFormParseError("EmployeeList JSON is not an array");
  }
  const employees: ResManEmployee[] = [];
  for (const item of json) {
    if (typeof item !== "object" || item === null) continue;
    const name = (item as Record<string, unknown>).Name;
    const personId = (item as Record<string, unknown>).PersonID;
    if (
      typeof name === "string" &&
      typeof personId === "string" &&
      name.trim() &&
      personId.trim()
    ) {
      employees.push({ name: name.trim(), personId: personId.trim() });
    }
  }
  return employees;
}

/**
 * Case-insensitive exact-name match, and it must be UNIQUE — two employees
 * sharing a display name is an ambiguity no writer should guess through.
 * Returns an error string instead of throwing, so one unresolvable name fails
 * one request, not a run.
 */
export function resolveTechnician(
  employees: readonly ResManEmployee[],
  displayName: string,
): { personId: string } | { error: string } {
  const wanted = displayName.trim().toLowerCase();
  if (!wanted) return { error: "technician name is empty" };
  // "Unassigned" is the app's display form of an EMPTY assignee, not a person
  // to find in the roster — resolve it to the empty id, which the engine
  // writes as a cleared AssignedToPersonID.
  if (wanted === "unassigned") return { personId: "" };
  // Match the roster's raw name OR its display-normalized form — the app
  // round-trips technicianDisplayName ("GROUNDS KEEPING" shows as "Grounds
  // Keepers"), and reassignments send the display form back.
  const matches = employees.filter(
    (employee) =>
      employee.name.toLowerCase() === wanted ||
      technicianDisplayName(employee.name).toLowerCase() === wanted,
  );
  if (matches.length === 0) {
    return { error: `no maintenance employee named ${JSON.stringify(displayName.trim())}` };
  }
  if (matches.length > 1) {
    return {
      error: `technician name ${JSON.stringify(displayName.trim())} is ambiguous (${matches.length} matches)`,
    };
  }
  return { personId: matches[0].personId };
}

// MARK: - The write engine

const EDIT_PATH = "/WorkOrders/Edit/";

export interface WorkOrderWriteEngineParams {
  http: ResManPageHttp;
  /** Consumer base URL, e.g. https://multisouth.myresman.com (no trailing slash). */
  baseUrl: string;
  request: WorkOrderWriteRequest;
  /** Resolves a technician display name to a person GUID once the form's
   *  PropertyID is known. Required when the patch carries `technicianName`. */
  resolveTechnicianName?: (propertyId: string) => Promise<{ personId: string } | { error: string }>;
  log?: (message: string) => void;
  /** Injected for tests. */
  now?: () => Date;
}

async function fetchEditForm(
  http: ResManPageHttp,
  base: string,
  workOrderId: string,
): Promise<{ controls: FormControl[]; html: string }> {
  const url = `${base}${EDIT_PATH}${workOrderId}`;
  const response = await http.getPage(url);
  if (isResManLoginRedirectUrl(response.finalUrl)) throw new ResManSessionExpiredError();
  if (response.status !== 200) {
    throw new ResManFormParseError(`HTTP ${response.status} for ${url}`);
  }
  return {
    controls: parseWorkOrderEditForm(response.text, workOrderId).controls,
    html: response.text,
  };
}

/** Resolve `technicianName` into `technicianPersonId` (mutating a COPY of the
 *  request) once the harvested PropertyID is known. */
async function withResolvedTechnician(
  params: WorkOrderWriteEngineParams,
  controls: FormControl[],
): Promise<WorkOrderWriteRequest> {
  const { request } = params;
  if (request.patch.technicianName === undefined) return request;
  if (request.patch.technicianPersonId !== undefined) return request;
  const wanted = request.patch.technicianName.trim().toLowerCase();
  if (wanted === "" || wanted === "unassigned") {
    // Clearing the assignee needs no roster round-trip.
    return { ...request, patch: { ...request.patch, technicianPersonId: "" } };
  }
  if (!params.resolveTechnicianName) {
    throw new WorkOrderWriteRefused("technicianName given but no resolver provided");
  }
  const propertyId = controlWireValue(requireControl(controls, "PropertyID")) ?? "";
  const resolved = await params.resolveTechnicianName(propertyId);
  if ("error" in resolved) throw new WorkOrderWriteRefused(resolved.error);
  return {
    ...request,
    patch: { ...request.patch, technicianPersonId: resolved.personId },
  };
}

/**
 * Apply one edit/close to ResMan. Throws `WorkOrderWriteRefused` (phase
 * preflight — nothing was sent), `ResManSessionExpiredError`, or
 * `ResManFormParseError` for transport/page failures before the POST; after
 * the POST every outcome is a returned result, never a throw.
 */
export async function applyWorkOrderWriteWithHttp(
  params: WorkOrderWriteEngineParams,
): Promise<WorkOrderWriteResult> {
  const { http, request } = params;
  const log = params.log ?? (() => {});
  const now = params.now ?? (() => new Date());
  if (request.kind !== "edit" && request.kind !== "close") {
    throw new WorkOrderWriteRefused(`unknown write kind ${String(request.kind)}`);
  }
  if (!GUID_RE.test(request.workOrderId)) {
    throw new WorkOrderWriteRefused(`work order id is not a GUID: ${request.workOrderId}`);
  }
  const base = params.baseUrl.replace(/\/$/, "");

  // 1. Harvest.
  const { controls, html } = await fetchEditForm(http, base, request.workOrderId);
  preflight(controls, request);
  // The Location display pair: ResMan persists its denormalized ObjectName
  // from this posted text on EVERY save. Refuse rather than post without it —
  // a save with it absent blanks the unit/building name off every list.
  const objectIdValue = controlWireValue(requireControl(controls, "ObjectID")) ?? "";
  const locationName = resolveWorkOrderLocationName(html, objectIdValue);
  if (locationName === null) {
    throw new WorkOrderWriteRefused(
      "page carries no display name for the work order's location — refusing a save that would blank it",
    );
  }
  synthesizeLocationControl(controls, locationName);
  const resolved = await withResolvedTechnician(params, controls);
  const before = serializeControls(controls);

  // 2. Mutate + diff.
  const { allowed, targets } = mutate(controls, resolved, now());
  if (allowed.size === 0) {
    log(
      `[wo-write] ${request.workOrderId} ${request.kind}: form already holds every target — no-op`,
    );
    return { ok: true, phase: "verified", noop: true, detail: "already applied" };
  }
  const after = serializeControls(controls);
  assertOnlyAllowedChanged(before, after, allowed);

  // 3. POST — one attempt, never retried here. The form submits natively (no
  // antiforgery token on this page), so the payload is exactly the successful
  // controls in document order.
  const url = `${base}${EDIT_PATH}${request.workOrderId}`;
  const postResponse = await http.postForm(url, resManFormURLEncode(after), url);
  log(`[wo-write] ${request.workOrderId} ${request.kind}: POST → ${postResponse.status}`);
  if (isResManLoginRedirectUrl(postResponse.finalUrl)) {
    // Session died between harvest and save — nothing was written.
    throw new ResManSessionExpiredError();
  }

  // 4. Verify by re-reading, never by trusting the POST's own response.
  let fresh: FormControl[];
  try {
    fresh = (await fetchEditForm(http, base, request.workOrderId)).controls;
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
  return {
    ok: true,
    phase: "verified",
    noop: false,
    postStatus: postResponse.status,
    detail: "verified",
  };
}

/**
 * Verify-only reconcile for a request whose earlier POST could not be
 * confirmed: re-read the form and report whether the targets are present now.
 * Never POSTs.
 */
export async function verifyWorkOrderWriteWithHttp(
  params: WorkOrderWriteEngineParams,
): Promise<WorkOrderWriteResult> {
  const { http, request } = params;
  const now = params.now ?? (() => new Date());
  const base = params.baseUrl.replace(/\/$/, "");
  const { controls } = await fetchEditForm(http, base, request.workOrderId);
  preflight(controls, request);
  const resolved = await withResolvedTechnician(params, controls);
  const { allowed } = mutate(controls, resolved, now());
  if (allowed.size === 0) {
    return { ok: true, phase: "verified", noop: true, detail: "already applied" };
  }
  return { ok: false, phase: "verified", noop: false, detail: "targets not present on re-read" };
}
