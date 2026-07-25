/**
 * ResMan CSV support — port of KrakenCore/Services/ResMan/ResManCSVSupport.swift.
 * Design §3.1 (`resman/csv.ts`).
 *
 * A small RFC-ish CSV reader plus the header-name→index lookup and scalar
 * parsers the DevExpress report parsers rely on. The parser is ported by hand
 * (rather than delegating to `csv-parse`) so its quirks match the Swift source
 * exactly — most importantly it drops all-empty rows and treats bare CR, LF, and
 * CRLF as row terminators. This is the heavily unit-tested piece (design §3.1).
 */

/** Header-name → column-index lookup with trim+lowercase normalization. */
export class CsvHeaderLookup {
  private readonly indexesByName: Map<string, number>;
  private readonly normalizer: (value: string) => string;

  constructor(
    headers: string[],
    normalizer: (value: string) => string = CsvHeaderLookup.defaultNormalizer,
  ) {
    this.normalizer = normalizer;
    this.indexesByName = new Map();
    headers.forEach((header, index) => {
      // Last write wins, matching the Swift dictionary-build order.
      this.indexesByName.set(normalizer(header), index);
    });
  }

  index(name: string): number | undefined {
    return this.indexesByName.get(this.normalizer(name));
  }

  indexFirstOf(names: string[]): number | undefined {
    for (const name of names) {
      const i = this.index(name);
      if (i !== undefined) return i;
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.index(name) !== undefined;
  }

  hasAny(names: string[]): boolean {
    return this.indexFirstOf(names) !== undefined;
  }

  /** Trimmed cell value for a named column, or "" when missing/out of range. */
  value(row: string[], name: string): string {
    const i = this.index(name);
    if (i === undefined || i >= row.length) return "";
    return row[i].trim();
  }

  static defaultNormalizer(value: string): string {
    return value.trim().toLowerCase();
  }
}

/** `["true","yes","1","y"]` (case-insensitive, trimmed) → true. */
export function parseBool(value: string): boolean {
  return ["true", "yes", "1", "y"].includes(value.trim().toLowerCase());
}

/** Strip `$` and thousands separators; return null for blank/non-numeric. */
export function parseDouble(value: string): number | null {
  const cleaned = value.trim().replace(/\$/g, "").replace(/,/g, "");
  if (cleaned.length === 0) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Strip thousands separators; return null for blank/non-integer. */
export function parseInt10(value: string): number | null {
  const cleaned = value.trim().replace(/,/g, "");
  if (cleaned.length === 0) return null;
  if (!/^[+-]?\d+$/.test(cleaned)) return null;
  return Number.parseInt(cleaned, 10);
}

/** The date formats ResMan's CSV exports emit (Swift `standardDateFormats`). */
export const STANDARD_DATE_FORMATS = [
  "M/d/yyyy h:mm:ss a",
  "MM/dd/yyyy h:mm:ss a",
  "M/d/yyyy",
  "MM/dd/yyyy",
  "M/d/yy",
  "MM/dd/yy",
  "yyyy-MM-dd",
] as const;

/**
 * Parse a ResMan CSV date. Handles `M/d/yyyy` (with optional `h:mm:ss a` time),
 * 2-digit years (mapped to the 2000s, matching DateFormatter's default century
 * window), and ISO `yyyy-MM-dd`. Returns a local `Date`, or null when the value
 * is blank or unrecognized. Mirrors `ResManCSVDateParser`.
 */
export function parseCsvDate(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    const [, y, m, d] = iso;
    return buildDate(+y, +m, +d, 0, 0, 0);
  }

  const us =
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AaPp][Mm]))?$/.exec(
      trimmed,
    );
  if (us) {
    const [, mm, dd, yy, hh, min, sec, ap] = us;
    let year = +yy;
    if (yy.length <= 2) year = 2000 + year;
    let hour = hh ? +hh : 0;
    if (ap) {
      const isPm = ap.toLowerCase() === "pm";
      if (isPm && hour !== 12) hour += 12;
      if (!isPm && hour === 12) hour = 0;
    }
    return buildDate(year, +mm, +dd, hour, min ? +min : 0, sec ? +sec : 0);
  }

  return null;
}

function buildDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  // Reject values the Date constructor silently rolled over (e.g. 2/30).
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

/** Normalize a ResMan CSV date to the schema's `yyyy-MM-dd`, or null. */
export function normalizeCsvDate(value: string): string | null {
  const date = parseCsvDate(value);
  if (!date) return null;
  const y = date.getFullYear().toString().padStart(4, "0");
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const d = date.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Decode raw CSV bytes to a string with the Swift fallback chain
 * (UTF-8 → Windows-1252 → Latin-1) and strip a leading BOM. Throws when no
 * encoding decodes the bytes.
 */
export function decodeCsvString(data: Uint8Array): string {
  let decoded: string | undefined;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    try {
      decoded = new TextDecoder("windows-1252").decode(data);
    } catch {
      decoded = new TextDecoder("latin1").decode(data);
    }
  }
  if (decoded === undefined) {
    throw new Error("CSV data could not be decoded (tried UTF-8, Windows-1252, and Latin-1)");
  }
  return decoded.startsWith("﻿") ? decoded.slice(1) : decoded;
}

/** Decode bytes and parse into rows in one step (Swift `decodeRows`). */
export function decodeCsvRows(data: Uint8Array): { csvString: string; rows: string[][] } {
  const csvString = decodeCsvString(data);
  return { csvString, rows: parseCsvRows(csvString) };
}

/**
 * Parse CSV text into rows. Faithful port of the Swift character scanner:
 *   - `"` toggles quoting; `""` inside a quoted field is a literal quote.
 *   - `,` separates fields.
 *   - CR, LF, and CRLF each terminate a row.
 *   - a row that is entirely empty fields is dropped.
 *   - the final field/row is flushed at EOF.
 */
export function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const pushRow = (): void => {
    row.push(field);
    field = "";
    if (!row.every((f) => f.length === 0)) rows.push(row);
    row = [];
  };

  let i = 0;
  const n = csv.length;
  while (i < n) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"') {
        if (i + 1 < n && csv[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
    } else {
      switch (ch) {
        case '"':
          // A quote only OPENS a field at its start (RFC 4180). Mid-field it is
          // a literal — `6" pipe leak` is an inch mark, not the start of a
          // quoted section. Treating it as an opener made the parser swallow
          // the entire rest of the file into one field: every row after it
          // vanished, and because the truncated result was still non-empty,
          // upsertMirror's delete-missing pass then deleted those units and
          // work orders (cascading their photos away) as "no longer in the
          // report".
          if (field.length === 0) quoted = true;
          else field += ch;
          break;
        case ",":
          row.push(field);
          field = "";
          break;
        case "\r":
          pushRow();
          // Swallow the LF of a CRLF pair so it does not start an empty row.
          if (i + 1 < n && csv[i + 1] === "\n") i += 1;
          break;
        case "\n":
          pushRow();
          break;
        default:
          field += ch;
      }
    }
    i += 1;
  }

  // An unterminated quote means the input is malformed or truncated, and the
  // rows parsed so far are a PREFIX of the real report. Returning them would
  // look like a successful short scrape and feed delete-missing. Fail loudly
  // instead — a thrown job is recoverable, a silent partial delete is not.
  if (quoted) {
    throw new Error(
      `CSV parse failed: unterminated quoted field (parsed ${rows.length} row(s) before EOF)`,
    );
  }

  // Flush the trailing field/row (Swift appends unconditionally, then drops all-empty).
  row.push(field);
  if (!row.every((f) => f.length === 0)) rows.push(row);

  return rows;
}
