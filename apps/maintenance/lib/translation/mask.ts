/**
 * Token masking for machine translation of work-order prose.
 *
 * Apple's on-device translator takes no glossary, so we protect the terms a
 * field tech must read verbatim by swapping them for opaque sentinels before
 * translation and restoring them after. Unit numbers, part/model numbers,
 * measurements, money, and trade abbreviations stay exactly as written while
 * the surrounding prose is translated. Engine-agnostic and pure.
 *
 * Deliberately conservative: a bare number in prose ("reported 3 times") is NOT
 * masked — only numbers carrying a unit, or tokens that are clearly codes, so
 * masking never fragments an otherwise translatable sentence.
 */

/** Sentinels the translator carries through untouched: `⟦0⟧`, `⟦1⟧`, … The
 *  bracket glyphs (non-ASCII) survive MT far better than `{0}` / `__0__`. */
function sentinel(i: number): string {
  return `⟦${i}⟧`;
}
const SENTINEL_RE = /⟦(\d+)⟧/g;

/** Trade abbreviations kept verbatim (exact, case-sensitive whole tokens). */
const ABBREVIATIONS = [
  "T&P", "HWH", "HVAC", "GFCI", "PTAC", "P-trap", "R-410A",
  "GPM", "BTU", "PM", "GD", "GC", "CO", "AC",
];

/**
 * Ordered protect patterns (most specific first). Each match becomes a sentinel.
 * None of them can match a sentinel (the bracket glyphs aren't word chars and
 * carry no letters), so masking is safe to run pattern-by-pattern.
 */
const PATTERNS: RegExp[] = [
  // Money and percentages: $1,240.50 · 45% · 3.5 %
  /\$\s?\d[\d,]*(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%/g,
  // Unit shorthand the mirror uses: "1710 CW-3", "3713 KG-3"
  /\b\d{2,5}\s+[A-Za-z]{1,4}-\d+\b/g,
  // Dimensions: 12x8 · 12 × 8.5
  /\b\d+(?:\.\d+)?\s?[x×]\s?\d+(?:\.\d+)?\b/gi,
  // Measurement with a quote/prime unit: 3/4" · 6' (no trailing \b — the symbol
  // is non-word, so a \b after it can't match before a space).
  /\b\d+(?:[./-]\d+)*\s?["'′″]/g,
  // Measurement with a word unit: 40-gal, 1-1/2in, 15 gallons, 220 psi
  /\b\d+(?:[./-]\d+)*\s?(?:gal(?:lon)?s?|inch(?:es)?|feet|foot|ft|in|lbs?|pounds?|oz|mm|cm|amps?|volts?|watts?|psi|gpm|btu|°?[FC])\b/gi,
  // Attached single-letter electrical units: 220v · 15A · 40W · 30k
  /\b\d+(?:\.\d+)?[vawk]\b/gi,
  // Codes: a token carrying at least one letter AND one digit (RH2040, A-4187, KG-3)
  /\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/g,
];

export interface MaskResult {
  /** Text with protected spans replaced by sentinels — what gets translated. */
  masked: string;
  /** Ordered replacements; index i maps to sentinel `⟦i⟧`. */
  tokens: string[];
}

/** Replace protected spans with sentinels; returns the masked text + token table. */
export function mask(text: string): MaskResult {
  if (!text) return { masked: text, tokens: [] };
  const tokens: string[] = [];
  const add = (value: string): string => {
    const i = tokens.length;
    tokens.push(value);
    return sentinel(i);
  };

  let out = text;
  for (const abbr of ABBREVIATIONS) {
    const re = new RegExp(`(?<![\\w&-])${escapeRegExp(abbr)}(?![\\w&-])`, "g");
    out = out.replace(re, (m) => add(m));
  }
  for (const pattern of PATTERNS) {
    // Ordinals ("2nd", "3rd") pass the code rule's letter+digit test but are
    // prose, not codes — leave them for the translator.
    out = out.replace(pattern, (m) => (/^\d+(?:st|nd|rd|th)$/i.test(m) ? m : add(m)));
  }
  return { masked: out, tokens };
}

/** Restore sentinels to their original spans; unknown indices are left intact. */
export function unmask(masked: string, tokens: string[]): string {
  if (tokens.length === 0) return masked;
  return masked.replace(SENTINEL_RE, (whole, digits) => {
    const i = Number(digits);
    return i >= 0 && i < tokens.length ? tokens[i] : whole;
  });
}

/** True when `text` still holds every sentinel from a mask — i.e. the translator
 *  didn't drop or mangle a placeholder. Callers fall back to the source when a
 *  translation fails this integrity check. */
export function sentinelsIntact(masked: string, tokenCount: number): boolean {
  for (let i = 0; i < tokenCount; i += 1) {
    if (!masked.includes(sentinel(i))) return false;
  }
  return true;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
