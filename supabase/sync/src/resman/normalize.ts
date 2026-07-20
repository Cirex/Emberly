/**
 * ResMan name / phone normalization — port of
 * KrakenCore/Services/ResMan/ResManNameNormalization.swift plus the tenant-name
 * and phone normalizers the All Units scraper and the detail scraper share.
 * Design §3.1 (`resman/normalize.ts`).
 */

/**
 * Title-case a single word/segment the way Swift's `String.capitalized` does:
 * uppercase the first letter of each word and lowercase the rest. Word breaks
 * are whitespace and the punctuation that appears in names — hyphen, apostrophe,
 * slash, and brackets — so "o'brien" → "O'Brien", "mary-jane" → "Mary-Jane" and
 * the register's "(BKRPTCY)" annotations → "(Bkrptcy)" rather than "(bkrptcy)".
 */
function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|[\s\-'/([])([a-zÀ-ɏ])/g, (_match, boundary: string, letter: string) => {
      return boundary + letter.toUpperCase();
    });
}

/**
 * Tokens that are correct in upper case and must survive title-casing: generation
 * suffixes, and the marque acronyms the register actually contains ("GMC" would
 * otherwise become "Gmc"). Deliberately short — anything not proven to appear is
 * better left to the general rule.
 */
const PRESERVED_UPPER = new Set(["II", "III", "IV", "BMW", "GMC", "VW"]);

/**
 * Collapse whitespace and tidy it around the separators that appear inside names
 * and vehicle terms, so "Dilworth -Handy" and "tan/ gold" stop being their own
 * distinct values.
 */
function normalizeSpacing(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s*([-/'])\s*/g, "$1")
    .trim();
}

/**
 * Converts ALL-CAPS or all-lowercase words to title case, leaving mixed-case
 * words alone (they are assumed already correctly cased: "McBride", "DeQuan").
 *
 * Diverges from the Swift `resManTitleCaseName` in one way, on purpose: the
 * original tested the *whole string*, so a single already-cased word anywhere
 * exempted the rest — "REGINA COLLINS Jr" stayed shouting because of the "Jr".
 * The rule is applied per word here, which fixes that and still leaves genuinely
 * mixed-case names untouched.
 */
export function titleCaseName(raw: string | undefined | null): string | undefined | null {
  if (raw === undefined || raw === null || raw.length === 0) return raw;

  return normalizeSpacing(raw)
    .split(" ")
    .map((word) => {
      if (PRESERVED_UPPER.has(word.toUpperCase()) && word === word.toUpperCase()) return word;
      const isAllUpper = word === word.toUpperCase();
      const isAllLower = word === word.toLowerCase();
      if (!isAllUpper && !isAllLower) return word;
      return titleCase(word);
    })
    .join(" ");
}

/**
 * Split a comma-separated residents string (as it appears in the All Units CSV's
 * `Residents` column) into individually title-cased display names. Trims each
 * name, title-cases ALL-CAPS/all-lowercase ones, and drops empty segments.
 *
 * Matches the Swift `ResManAllUnitsScraper` behavior asserted by the fixtures:
 * "FIRST NAME, second resident, McBride Resident"
 *   → ["First Name", "Second Resident", "McBride Resident"].
 */
export function normalizeTenantNames(raw: string): string[] {
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => titleCaseName(name) ?? name);
}

/**
 * Normalize a US phone number to `(XXX) XXX-XXXX`. Strips all non-digits; if the
 * result is 11 digits with a leading `1`, the country code is dropped. Returns
 * the trimmed original when it does not contain exactly 10 significant digits
 * (extensions, international, or already-odd formats are passed through).
 */
export function normalizePhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return raw.trim();
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

/* ---------------- US state normalization ---------------- */

const STATE_BY_NAME: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA",
  COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA",
  HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA",
  KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
  MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS",
  MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
  "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
  "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK",
  OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT",
  VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI",
  WYOMING: "WY", "DISTRICT OF COLUMBIA": "DC",
};

const STATE_CODES = new Set(Object.values(STATE_BY_NAME));

/**
 * Any way a human wrote a US state, to its two-letter code: "Tennessee" → TN,
 * "T.N" → TN, "TN PINK" → TN, "ARK"/"ARKANSASA" → AR. Values that cannot be
 * resolved to a state (plates typed in the wrong box, "NA", "000000") come
 * back empty — a wrong guess in a *state* column is worse than a blank.
 */
export function normalizeState(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "";
  if (STATE_CODES.has(cleaned)) return cleaned;
  if (STATE_BY_NAME[cleaned]) return STATE_BY_NAME[cleaned];

  // Punctuated codes ("T.N") arrive here as "T N" — try them squeezed.
  const compact = cleaned.replace(/ /g, "");
  if (STATE_CODES.has(compact)) return compact;

  // A valid code hiding among noise ("TN PINK") — but only when exactly one
  // token is a code, otherwise the value is ambiguous.
  const tokens = cleaned.split(" ");
  const codeTokens = tokens.filter((t) => STATE_CODES.has(t));
  if (codeTokens.length === 1) return codeTokens[0];

  // Truncations and trailing-typo spellings ("ARK", "ARKANSASA", "TENN"):
  // resolve only when a single state matches the prefix either way.
  if (cleaned.length >= 3) {
    const matches = Object.entries(STATE_BY_NAME).filter(
      ([name]) => name.startsWith(cleaned) || cleaned.startsWith(name),
    );
    if (matches.length === 1) return matches[0][1];
  }

  return "";
}

/**
 * Identity of a physical vehicle within one unit, for de-duplication: the
 * plate when there is one (a plate is the car), otherwise the exact
 * make/model/year/color. ResMan happily stores the same car once per
 * person-lease, which reads as duplicates everywhere we show "vehicles on
 * file" for a unit.
 */
export function vehicleIdentityKey(
  unitKey: string,
  v: { make: string; model: string; year: string; color: string; license_plate: string },
): string {
  const plate = v.license_plate.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (plate.length > 0) return `${unitKey}|P|${plate}`;
  const spec = [v.make, v.model, v.year, v.color].map((s) => s.trim().toUpperCase()).join("|");
  return `${unitKey}|V|${spec}`;
}
