/**
 * MLGW HTML form parsing + submission. Port of
 * KrakenCore/Services/MLGW/MLGWHTMLForms.swift.
 *
 * Parses `<form>`/`<input>`/`<select>` markup into full forms (with select
 * defaults + text) or lightweight shells, URL-encodes fields the way the portal
 * expects (space → `+`, only `-._*` unescaped), and replays a form as GET or POST.
 */
import type { MLGWHTTPClient } from "../http";
import { type HTTPResponse, ScriptError } from "../types";
import { attributes, cachedRegex, resolveURL, stripTags } from "../text";

export interface HTMLForm {
  action: URL;
  method: string;
  fields: Record<string, string>;
  text: string;
  bodyHTML: string;
}

export interface HTMLFormShell {
  action: URL;
  method: string;
  fields: Record<string, string>;
}

interface HTMLSelectOption {
  value: string;
  text: string;
  isSelected: boolean;
}

interface HTMLSelectControl {
  name: string;
  options: HTMLSelectOption[];
}

/** All `name=value` pairs from `<input>` elements. Port of `inputFields`. */
export function inputFields(html: string): Record<string, string> {
  const regex = cachedRegex("<input\\b([^>]*)>", "gis");
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(regex)) {
    const attrs = attributes(match[1] ?? "");
    const name = attrs["name"];
    if (name === undefined || name === "") continue;
    fields[name] = attrs["value"] ?? "";
  }
  return fields;
}

function selectOptions(html: string): HTMLSelectOption[] {
  const regex = cachedRegex("<option\\b([^>]*)>(.*?)</option>", "gis");
  const options: HTMLSelectOption[] = [];
  for (const match of html.matchAll(regex)) {
    const rawAttributes = match[1] ?? "";
    const attrs = attributes(rawAttributes);
    const text = stripTags(match[2] ?? "");
    options.push({
      value: attrs["value"] ?? text,
      text,
      isSelected: /\bselected\b/i.test(rawAttributes),
    });
  }
  return options;
}

function selectControls(html: string): HTMLSelectControl[] {
  const regex = cachedRegex("<select\\b([^>]*)>(.*?)</select>", "gis");
  const controls: HTMLSelectControl[] = [];
  for (const match of html.matchAll(regex)) {
    const attrs = attributes(match[1] ?? "");
    const name = attrs["name"];
    if (name === undefined || name === "") continue;
    const options = selectOptions(match[2] ?? "");
    if (options.length === 0) continue;
    controls.push({ name, options });
  }
  return controls;
}

/** Parse full forms (fields + select defaults + stripped text). Port of `parseForms`. */
export function parseForms(html: string, baseURL: URL): HTMLForm[] {
  const regex = cachedRegex("<form\\b([^>]*)>(.*?)</form>", "gis");
  const forms: HTMLForm[] = [];
  for (const match of html.matchAll(regex)) {
    const formAttributes = attributes(match[1] ?? "");
    const action = resolveURL(formAttributes["action"] ?? baseURL.toString(), baseURL);
    if (action === null) continue;
    const method = (formAttributes["method"] ?? "GET").toUpperCase();
    const body = match[2] ?? "";
    const fields = inputFields(body);
    for (const control of selectControls(body)) {
      const selected = control.options.find((option) => option.isSelected) ?? control.options[0];
      if (selected !== undefined) fields[control.name] = selected.value;
    }
    forms.push({ action, method, fields, text: stripTags(body), bodyHTML: body });
  }
  return forms;
}

/** Parse only form action/method/fields (no select defaults or text). Port of `lightweightForms`. */
export function lightweightForms(html: string, baseURL: URL): HTMLFormShell[] {
  const regex = cachedRegex("<form\\b([^>]*)>(.*?)</form>", "gis");
  const forms: HTMLFormShell[] = [];
  for (const match of html.matchAll(regex)) {
    const formAttributes = attributes(match[1] ?? "");
    const action = resolveURL(formAttributes["action"] ?? baseURL.toString(), baseURL);
    if (action === null) continue;
    const method = (formAttributes["method"] ?? "GET").toUpperCase();
    forms.push({ action, method, fields: inputFields(match[2] ?? "") });
  }
  return forms;
}

const ENCODER = new TextEncoder();

function encodeFormComponent(value: string): string {
  let out = "";
  for (const char of value) {
    if (/[A-Za-z0-9\-._*]/.test(char)) {
      out += char;
    } else if (char === " ") {
      out += "+";
    } else {
      for (const byte of ENCODER.encode(char)) {
        out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

/** URL-encode form fields (space → `+`, only `-._*` left literal). Port of `formURLEncoded`. */
export function formURLEncoded(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeFormComponent(key)}=${encodeFormComponent(value)}`)
    .join("&");
}

/** Replay a form (GET query or POST body) with optional field overrides. Port of `submitForm`. */
export async function submitForm(
  client: MLGWHTTPClient,
  form: HTMLForm,
  overrides: Record<string, string> = {},
): Promise<HTTPResponse> {
  const fields = { ...form.fields, ...overrides };
  if (form.method === "GET") {
    let url: URL;
    try {
      url = new URL(form.action.toString());
    } catch {
      throw ScriptError.ssoFailed("Could not build form GET URL.");
    }
    for (const [key, value] of Object.entries(fields)) url.searchParams.append(key, value);
    return client.request("GET", url);
  }
  return client.request("POST", form.action, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formURLEncoded(fields),
  });
}
