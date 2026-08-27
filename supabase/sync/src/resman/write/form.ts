/**
 * ResMan work-order edit-form parsing and re-serialization — the harvest half
 * of the write path (design: docs/Web-API.md "work-order write path"; recon
 * captured 2026-08-26 against live WOs 16305/16376, fixtures in
 * tests/fixtures/work-order-edit-*.html).
 *
 * The write path is a form replay: GET /WorkOrders/Edit/{id}, harvest the
 * `NewEditWorkOrderForm` controls, mutate an allowlisted few, POST the whole
 * set back in document order. Everything here is deliberately faithful to what
 * the BROWSER would submit, not to what looks tidy:
 *
 *   - Attribute values can contain a raw `>` (Description's
 *     data-val-regex message does). A naive `<input[^>]*>` regex truncates the
 *     tag there and silently DROPS the Description control — the exact field
 *     we edit — so tags are walked with a quote-aware scanner, never a regex.
 *   - `<option>Submitted</option>` has no value attribute; HTML submits the
 *     option TEXT. Status/Priority rely on this.
 *   - The combobox selects (ObjectID, AssignedToPersonID, VendorID, …) carry
 *     the current value in `data-selected-value`; the page's own JS re-populates
 *     their options and selects that value, so when the attribute is present it
 *     IS the wire value — regardless of what the server-rendered option list
 *     says. (ObjectID's list is empty server-side; the employee/vendor lists
 *     are rendered but unselected.)
 *   - Areas and Pets are `multiple` selects: one pair per selected option and
 *     NOTHING when none is selected — a single-select "first option" default
 *     there would inject a spurious area/pet into every write.
 *   - The ASP.NET checkbox pair (checkbox "true" + hidden "false") submits
 *     only the hidden "false" while unchecked — matching the live capture.
 *   - Dates are property-local wall time in three spellings:
 *     `8/26/2026 7:43:00 PM` composite, `08/26/2026` date twin, and an always
 *     empty `.Time` — exactly as captured from a real save.
 */

import { ResManScrapingError } from "../errors";

// MARK: - Model

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
  /** `data-selected-value` on async comboboxes; null when absent. */
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
function nextTag(html: string, from: number, names: readonly string[]): { tag: RawTag; start: number } | null {
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
 * document order. Throws `parsingFailed` when the form is missing or the
 * action is not the expected `/WorkOrders/Edit/{workOrderId}` — the URL
 * assertion is deliberately here, at parse time, so a page that is not the
 * expected edit form can never be serialized at all.
 */
export function parseWorkOrderEditForm(html: string, workOrderId: string): ParsedWorkOrderEditForm {
  const marker = html.indexOf('id="NewEditWorkOrderForm"');
  if (marker === -1) {
    throw ResManScrapingError.parsingFailed("NewEditWorkOrderForm not found in page");
  }
  const formStart = html.lastIndexOf("<form", marker);
  if (formStart === -1) {
    throw ResManScrapingError.parsingFailed("NewEditWorkOrderForm has no <form> tag");
  }
  const formTag = parseTag(html, formStart);
  if (!formTag || formTag.tag !== "form") {
    throw ResManScrapingError.parsingFailed("NewEditWorkOrderForm form tag failed to parse");
  }
  const action = formTag.attrs.get("action") ?? "";
  const expectedAction = `/WorkOrders/Edit/${workOrderId}`;
  if (action !== expectedAction) {
    throw ResManScrapingError.parsingFailed(
      `edit form action mismatch: expected ${expectedAction}, got ${action || "(empty)"}`,
    );
  }
  if ((formTag.attrs.get("method") ?? "").toLowerCase() !== "post") {
    throw ResManScrapingError.parsingFailed("edit form method is not post");
  }
  const formEnd = html.indexOf("</form>", formTag.end);
  if (formEnd === -1) {
    throw ResManScrapingError.parsingFailed("edit form is never closed");
  }

  const controls: FormControl[] = [];
  let i = formTag.end;
  while (i < formEnd) {
    const found = nextTag(html, i, CONTROL_TAGS);
    if (!found || found.start >= formEnd) break;
    const { tag } = found;
    i = tag.end;
    if (tag.tag === "form") {
      throw ResManScrapingError.parsingFailed("nested <form> inside NewEditWorkOrderForm");
    }
    const name = tag.attrs.get("name");

    if (tag.tag === "select") {
      const close = html.indexOf("</select>", tag.end);
      if (close === -1 || close > formEnd) {
        throw ResManScrapingError.parsingFailed(`unclosed <select ${name ?? "?"}>`);
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
        throw ResManScrapingError.parsingFailed(`unclosed <textarea ${name ?? "?"}>`);
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
    throw ResManScrapingError.parsingFailed("edit form has no named controls");
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
    throw ResManScrapingError.parsingFailed(`${control.name} is a multi-select`);
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
  throw ResManScrapingError.parsingFailed(`duplicate form control: ${name}`);
}

/**
 * Point a control at a new wire value, the way the page's own JS would:
 * inputs/textareas get the value; option-backed selects move `selected` to the
 * matching option (throwing when no option matches — never invent an option);
 * async comboboxes get `data-selected-value`.
 */
export function setControlValue(control: FormControl, value: string): void {
  if (control.multiple) {
    throw ResManScrapingError.parsingFailed(`refusing to mutate multi-select ${control.name}`);
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
    throw ResManScrapingError.parsingFailed(
      `select ${control.name} has no option ${JSON.stringify(value)}`,
    );
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
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
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
