/**
 * MLGW shared text / HTML / regex / URL helpers — the low-level utilities the
 * MLGW parsers, scrapers, and session code all import.
 *
 * Ports (KrakenCore/Sources/KrakenCore/Services/MLGW/):
 *   - MLGWCellStringSupport.swift  -> trimmedForCell, nilIfBlank
 *   - MLGWRegexSupport.swift       -> cachedRegex, replacingMatches (+ the cache)
 *   - MLGWTextRegexSupport.swift   -> firstMatch, allMatches, regexGroupMatches,
 *                                     lineValue
 *   - MLGWHTMLTextSupport.swift    -> htmlDecode, attributes, stripTags,
 *                                     fastHTMLText
 *   - MLGWHTMLToText.swift         -> htmlToText
 *   - MLGWHTMLLinks.swift          -> HTMLLink, htmlLinks
 *   - MLGWURLQuerySupport.swift    -> resolveURL, queryFields,
 *                                     cleanedBillDocumentId,
 *                                     billDocumentIdFromFields,
 *                                     billDocumentIdFromURL,
 *                                     billDocumentIdFromAttributes,
 *                                     urlByAddingQueryFields,
 *                                     urlBySettingQueryFields
 *   - MLGWDecimalParsing.swift     -> parseDecimal (delegates to `parseDouble`)
 *
 * Translation notes (brief §4/§10):
 *   - Swift `NSRegularExpression` -> JS `RegExp`. Inline `(?i)`/`(?is)` flags are
 *     lifted to JS flag strings (`i` / `is`); a `g` flag is added where the Swift
 *     used `matches(in:)` (all-matches) or `stringByReplacingMatches`.
 *     `cachedRegex` is a `Map`-cached compiler keyed by `flags|pattern`.
 *   - `String.trimmedForCell()` / `String.nilIfBlank` become free functions.
 *   - Decimal parsing reuses `parseDouble` from `../resman/csv` (brief §10).
 *   - The disk-reading variants (`htmlText(from:URL)`, `billText(from:)`) are
 *     intentionally NOT ported here — see the note at the bottom of the file.
 */

import { parseDouble } from "../resman/csv";

// MARK: - Cell strings (MLGWCellStringSupport.swift)

/**
 * Trim leading/trailing whitespace and newlines, then normalize a non-breaking
 * space (U+00A0) to a regular space. Faithful port of `String.trimmedForCell()`.
 */
export function trimmedForCell(s: string): string {
  return s.trim().replace(/ /g, " ");
}

/**
 * The trimmed string, or `null` when it is blank after trimming. Port of the
 * Swift `String.nilIfBlank` computed property (note: uses plain `trim`, not the
 * NBSP-normalizing `trimmedForCell`, matching Swift's
 * `trimmingCharacters(in: .whitespacesAndNewlines)`).
 */
export function nilIfBlank(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

// MARK: - Regex cache (MLGWRegexSupport.swift)

const regexCache = new Map<string, RegExp>();

/**
 * Compile-and-cache a `RegExp`, keyed by `flags|pattern` (the JS analog of the
 * Swift `MLGWRegexCache` keyed by `options.rawValue|pattern`). `flags` are
 * normalized (sorted, de-duplicated) so callers that request the same effective
 * flag set share a cache entry. Unlike the Swift version — which returned `nil`
 * for an invalid pattern — this throws, since the ported patterns are static and
 * known-good.
 */
export function cachedRegex(pattern: string, flags = ""): RegExp {
  const normalizedFlags = [...new Set(flags.split(""))].sort().join("");
  const key = `${normalizedFlags}|${pattern}`;
  const cached = regexCache.get(key);
  if (cached !== undefined) return cached;
  const regex = new RegExp(pattern, normalizedFlags);
  regexCache.set(key, regex);
  return regex;
}

/**
 * Replace every match of `pattern` in `text` with `replacement`. Port of the
 * Swift `replacingMatches`, which used `stringByReplacingMatches` (all matches);
 * a `g` flag is always added. `replacement` uses JS `String.replace` semantics
 * (`$1`, `$&`, …), which coincide with the `NSRegularExpression` template syntax
 * for the literal replacements the MLGW code passes.
 */
export function replacingMatches(
  text: string,
  pattern: string,
  replacement: string,
  flags = "",
): string {
  return text.replace(cachedRegex(pattern, flags + "g"), replacement);
}

// MARK: - HTML entity decoding (MLGWHTMLTextSupport.swift)

/**
 * Decode the HTML entities MLGW's markup uses: the six named entities the Swift
 * handled explicitly, then decimal (`&#NN;`) and hex (`&#xNN;`) numeric
 * references. An out-of-range or surrogate code point is left untouched (Swift
 * skipped the replacement when `UnicodeScalar(_:)` returned nil). Port of
 * `htmlDecode`.
 */
export function htmlDecode(value: string): string {
  const named = value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  return named.replace(
    /&#x([0-9a-fA-F]+);|&#([0-9]+);/g,
    (full, hex: string | undefined, dec: string | undefined): string => {
      const raw = hex !== undefined ? hex : dec;
      if (raw === undefined) return full;
      const scalarValue = Number.parseInt(raw, hex !== undefined ? 16 : 10);
      if (!Number.isFinite(scalarValue)) return full;
      if (scalarValue > 0x10ffff || (scalarValue >= 0xd800 && scalarValue <= 0xdfff)) {
        return full;
      }
      try {
        return String.fromCodePoint(scalarValue);
      } catch {
        return full;
      }
    },
  );
}

// MARK: - HTML attribute + tag parsing (MLGWHTMLTextSupport.swift)

/**
 * Parse the attributes out of an HTML tag (or a run of attribute text) into a
 * lowercased-key map, HTML-decoding each value. Faithful port of
 * `attributes(from:)`; supports double-quoted, single-quoted, and unquoted
 * values, and preserves the "first non-empty capture group wins" ordering.
 */
export function attributes(from: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = cachedRegex(
    "([a-zA-Z_:][-a-zA-Z0-9_:.]*)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^'\">\\s]+))",
    "g",
  );
  for (const match of from.matchAll(regex)) {
    const key = match[1].toLowerCase();
    let value = "";
    for (let group = 2; group <= 4; group += 1) {
      if (match[group] !== undefined) {
        value = match[group];
        break;
      }
    }
    result[key] = htmlDecode(value);
  }
  return result;
}

/**
 * Strip all markup to plain text: drop `<script>`/`<style>` blocks (dot-matches-
 * newline), remove every remaining tag, collapse whitespace runs, then
 * `trimmedForCell`. Port of `stripTags`.
 */
export function stripTags(html: string): string {
  let text = replacingMatches(html, "<script\\b[^>]*>.*?</script>", " ", "is");
  text = replacingMatches(text, "<style\\b[^>]*>.*?</style>", " ", "is");
  text = replacingMatches(text, "<[^>]+>", " ");
  text = replacingMatches(text, "\\s+", " ");
  return trimmedForCell(text);
}

/**
 * A fast, single-pass tag stripper that collapses whitespace as it goes, then
 * HTML-decodes and `trimmedForCell`s the result. Faithful port of the
 * `fastHTMLText` character scanner. `\s` matches the same whitespace set as
 * Swift's `Character.isWhitespace` for MLGW's markup (including U+00A0).
 */
export function fastHTMLText(html: string): string {
  let text = "";
  let insideTag = false;
  let lastWasSpace = true;

  for (const character of html) {
    if (character === "<") {
      insideTag = true;
      if (!lastWasSpace) {
        text += " ";
        lastWasSpace = true;
      }
      continue;
    }
    if (character === ">") {
      insideTag = false;
      continue;
    }
    if (insideTag) continue;
    if (/\s/.test(character)) {
      if (!lastWasSpace) {
        text += " ";
        lastWasSpace = true;
      }
    } else {
      text += character;
      lastWasSpace = false;
    }
  }

  return trimmedForCell(htmlDecode(text));
}

// MARK: - HTML -> text (MLGWHTMLToText.swift)

/** Swift `.newlines` CharacterSet — split on any Unicode line break. */
const NEWLINES = /[\n\r\u0085\u2028\u2029]/;

/**
 * Convert HTML to readable multi-line text: strip `<script>`/`<style>`, turn
 * `<br>` and block-level close tags into newlines (`<td>`/`<th>` into a double
 * space), drop remaining tags, HTML-decode, then per-line collapse whitespace,
 * `trimmedForCell`, and drop blank lines. Faithful port of `htmlToText`.
 *
 * Note: unlike `stripTags`, the Swift `<script>`/`<style>` removal here did NOT
 * use dot-matches-newline, so those substitutions use case-insensitive-only
 * flags (`.*?` will not cross a newline).
 */
export function htmlToText(html: string): string {
  // "is" — dotAll is REQUIRED. Without it `.*?` cannot cross a newline, so a
  // multi-line <script>/<style> block survives and its CSS/JS text is treated
  // as bill content: it lands in the parser's input and in the captured
  // transcript PDF.
  let text = replacingMatches(html, "<script\\b[^>]*>.*?</script>", " ", "is");
  text = replacingMatches(text, "<style\\b[^>]*>.*?</style>", " ", "is");
  text = replacingMatches(text, "<br\\s*/?>", "\n", "i");
  text = replacingMatches(text, "</(tr|div|p|li|h[1-6]|section|article|table)>", "\n", "i");
  text = replacingMatches(text, "</(td|th)>", "  ", "i");
  text = replacingMatches(text, "<[^>]+>", " ");
  text = htmlDecode(text);
  return text
    .split(NEWLINES)
    .map((line) => trimmedForCell(line.replace(/\s+/g, " ")))
    .filter((line) => line.length > 0)
    .join("\n");
}

// MARK: - Text/regex extraction (MLGWTextRegexSupport.swift)

/**
 * Return capture `group` (default 1) of the first case-insensitive,
 * dot-matches-newline match of `pattern` in `text`, `trimmedForCell`'d — or
 * `null` when there is no match or the group did not participate. Port of
 * `firstMatch(in:pattern:group:)`.
 */
export function firstMatch(text: string, pattern: string, group = 1): string | null {
  const regex = cachedRegex(pattern, "is");
  const match = regex.exec(text);
  if (match === null || match.length <= group || match[group] === undefined) {
    return null;
  }
  return trimmedForCell(match[group]);
}

/**
 * Every capture-group-1 value across all case-insensitive matches of `pattern`,
 * un-trimmed (as the Swift returned them). Port of `allMatches(in:pattern:)`.
 */
export function allMatches(text: string, pattern: string): string[] {
  const regex = cachedRegex(pattern, "gi");
  const results: string[] = [];
  for (const match of text.matchAll(regex)) {
    if (match.length > 1 && match[1] !== undefined) {
      results.push(match[1]);
    }
  }
  return results;
}

/**
 * For every case-insensitive, dot-matches-newline match, the list of its
 * participating capture groups (groups 1…n), each `trimmedForCell`'d;
 * non-participating groups are dropped. Port of `regexGroupMatches`.
 */
export function regexGroupMatches(text: string, pattern: string): string[][] {
  const regex = cachedRegex(pattern, "gis");
  const results: string[][] = [];
  for (const match of text.matchAll(regex)) {
    const groups: string[] = [];
    for (let index = 1; index < match.length; index += 1) {
      const value = match[index];
      if (value !== undefined) groups.push(trimmedForCell(value));
    }
    results.push(groups);
  }
  return results;
}

/**
 * Find the first line matching `labelPattern` and return the value that follows
 * the label: the inline capture-group-1 text if present and non-empty, else the
 * next line, `trimmedForCell`'d; `""` when nothing matches. Port of
 * `lineValue(after:in:)`.
 */
export function lineValue(labelPattern: string, lines: string[]): string {
  const labelRegex = cachedRegex(labelPattern, "i");
  for (let index = 0; index < lines.length; index += 1) {
    const match = labelRegex.exec(lines[index]);
    if (match !== null) {
      if (match.length > 1 && match[1] !== undefined) {
        const inline = trimmedForCell(match[1]);
        if (inline.length > 0) return inline;
      }
      if (index + 1 < lines.length) {
        return trimmedForCell(lines[index + 1]);
      }
    }
  }
  return "";
}

// MARK: - HTML links (MLGWHTMLLinks.swift)

/**
 * A link scraped from HTML. The Swift tuple also carried the source `range`, but
 * no caller uses it, so it is omitted here (per the port brief's `HTMLLink`
 * shape).
 */
export interface HTMLLink {
  url: URL;
  attributes: Record<string, string>;
  text: string;
}

/**
 * Extract `<a>`-like links (any element carrying `href` / `data-href` /
 * `data-url`) from `html`, resolving each URL against `baseURL`. Skips elements
 * whose URL fails to resolve (blank / `javascript:` / invalid). Faithful port of
 * `htmlLinks(in:baseURL:)`, including the backreference-closed element pattern.
 */
export function htmlLinks(html: string, baseURL: URL): HTMLLink[] {
  const links: HTMLLink[] = [];
  const linkPattern =
    "<([A-Za-z][A-Za-z0-9:_-]*)\\b([^>]*(?:href|data-href|data-url)\\s*=\\s*['\"][^'\"]+['\"][^>]*)>(.*?)</\\1>";
  const regex = cachedRegex(linkPattern, "gis");

  for (const match of html.matchAll(regex)) {
    const attrText = match[2];
    const innerText = match[3];
    if (attrText === undefined || innerText === undefined) continue;
    const attrs = attributes(attrText);
    const rawURL = attrs["data-href"] ?? attrs["data-url"] ?? attrs["href"] ?? "";
    const url = resolveURL(rawURL, baseURL);
    if (url === null) continue;
    links.push({ url, attributes: attrs, text: innerText });
  }

  return links;
}

// MARK: - URL / query support (MLGWURLQuerySupport.swift)

/**
 * Resolve `raw` (an HTML-encoded href) against `base`, returning an absolute
 * `URL` — or `null` for a blank, `javascript:`, or otherwise unparseable value.
 * Port of `resolveURL(_:base:)`.
 */
export function resolveURL(raw: string, base: URL): URL | null {
  const decoded = htmlDecode(raw).trim();
  if (decoded.length === 0 || decoded.toLowerCase().startsWith("javascript:")) {
    return null;
  }
  try {
    return new URL(decoded, base);
  } catch {
    return null;
  }
}

/**
 * The query parameters of `url` as a map (last value wins for repeated names,
 * matching the Swift dictionary build). Port of `queryFields(from:)`.
 */
export function queryFields(url: URL): Record<string, string> {
  const fields: Record<string, string> = {};
  url.searchParams.forEach((value, name) => {
    fields[name] = value;
  });
  return fields;
}

/** Trimmed document id, or `null` when blank. Port of `cleanedBillDocumentId`. */
export function cleanedBillDocumentId(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").trim();
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * The document id carried by a `documentid` / `docid` query field, or `null`.
 * Port of the `billDocumentId(from: [String:String])` overload.
 */
export function billDocumentIdFromFields(fields: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(fields)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "documentid" || normalizedKey === "docid") {
      const cleaned = cleanedBillDocumentId(value);
      if (cleaned !== null) return cleaned;
    }
  }
  return null;
}

/**
 * The document id carried by `url`'s query string, or `null`. Port of the
 * `billDocumentId(from: URL)` overload.
 */
export function billDocumentIdFromURL(url: URL): string | null {
  return billDocumentIdFromFields(queryFields(url));
}

/**
 * The document id carried by one of the known `data-*` / id attributes, or
 * `null`. Port of `billDocumentIdFromAttributes`.
 */
export function billDocumentIdFromAttributes(
  attrs: Record<string, string>,
): string | null {
  for (const key of ["data-document-id", "data-documentid", "documentid", "data-doc-id", "docid"]) {
    const cleaned = cleanedBillDocumentId(attrs[key]);
    if (cleaned !== null) return cleaned;
  }
  return null;
}

/**
 * Return `url` with `fields` appended as query items, but only for names not
 * already present; fields are added in sorted-key order. Port of
 * `urlByAddingQueryFields`.
 */
export function urlByAddingQueryFields(url: URL, fields: Record<string, string>): URL {
  const keys = Object.keys(fields);
  if (keys.length === 0) return url;
  const result = new URL(url.toString());
  const existing = new Set<string>();
  result.searchParams.forEach((_value, name) => existing.add(name));
  for (const key of keys.sort()) {
    if (!existing.has(key)) {
      result.searchParams.append(key, fields[key]);
    }
  }
  return result;
}

/**
 * Return `url` with `fields` applied: existing query items whose name matches
 * (case-insensitively) are overwritten in place (adopting the field's exact key
 * casing and value); the rest are appended in sorted-key order. Port of
 * `urlBySettingQueryFields`.
 */
export function urlBySettingQueryFields(url: URL, fields: Record<string, string>): URL {
  const keys = Object.keys(fields);
  if (keys.length === 0) return url;

  const overrides = new Map<string, { key: string; value: string }>();
  for (const key of keys) {
    overrides.set(key.toLowerCase(), { key, value: fields[key] });
  }

  const items: Array<[string, string]> = [];
  url.searchParams.forEach((value, name) => items.push([name, value]));

  const applied = new Set<string>();
  const nextItems: Array<[string, string]> = items.map(([name, value]) => {
    const normalizedName = name.toLowerCase();
    const override = overrides.get(normalizedName);
    if (override === undefined) return [name, value];
    applied.add(normalizedName);
    return [override.key, override.value];
  });

  for (const key of keys.sort()) {
    if (!applied.has(key.toLowerCase())) {
      nextItems.push([key, fields[key]]);
    }
  }

  const result = new URL(url.toString());
  const params = new URLSearchParams();
  for (const [name, value] of nextItems) {
    params.append(name, value);
  }
  result.search = params.toString();
  return result;
}

// MARK: - Decimal parsing (MLGWDecimalParsing.swift)

/**
 * Parse a money/decimal string (stripping `$` and thousands separators) to a
 * `number`, or `null` for a nil/blank/non-numeric value. Port of the Swift
 * `decimal(from:)`; delegates to `parseDouble` from the ResMan CSV support so
 * the cleaning rules stay identical (brief §10).
 */
export function parseDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return parseDouble(value);
}

/*
 * Intentionally NOT ported here (left to their owning module's agent):
 *   - `htmlText(from: URL)` / `billText(from:)` (MLGWHTMLToText.swift,
 *     MLGWTextParsingSupport.swift): they read bytes from disk / dispatch to PDF
 *     text extraction. Per brief §2/§3 the download/parse layer owns the
 *     `PdfTextExtractor` seam and operates on in-memory bytes / `HTTPResponse`,
 *     so those wrappers belong there, built on `htmlToText` exported above.
 *   - HTML *form* parsing (MLGWHTMLForms.swift / MLGWHTMLFormTypes.swift): a
 *     session/parse concern, not a shared low-level text helper.
 */
