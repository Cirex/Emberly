/**
 * Port of KrakenCore/Services/MLGW/MLGWBillAddressParser.swift.
 *
 * `cleanServiceAddress` strips the boilerplate that MLGW's text extraction runs
 * onto the "Services at" line (page footers, "UTILITY BILL", trailing account
 * numbers, meter-reader tables) and, when the address matches the bill's known
 * house-account fallback, prefers the fully-formatted fallback spelling.
 *
 * `serviceAddressPrefix` (the whitespace-normalizing free function) belongs to
 * the bill-list group; it is imported from `../bill-list` (brief: import from a
 * sibling barrel and assume it exists).
 */

import { replacingMatches, trimmedForCell } from "../text";
import { serviceAddressPrefix } from "../bill-list";

const PAGE_SUFFIX = "\\s+Page\\s+[0-9]+\\s+of\\s+[0-9]+.*$";
const UTILITY_BILL_SUFFIX = "\\s+UTILITY\\s+BILL.*$";
const ACCOUNT_SUFFIX = "\\s+Account\\s*(?:Number|No\\.?|#)?\\s*:?\\s*[0-9][0-9 \\-]{4,}[0-9].*$";
const METER_SUFFIX =
  "\\s+(?:meter\\s+reader\\b|previous\\s+balance\\b|balance\\s+forward\\b|readings\\s+usage\\s+amount\\s+total\\b|service\\s*:).*$";

/** Faithful port of `cleanServiceAddress(_:fallback:)`. */
export function cleanServiceAddress(value: string, fallback: string | null): string {
  const fallbackHouseAddress = preferredHouseServiceAddress(fallback);

  let cleaned = value;
  cleaned = replacingMatches(cleaned, PAGE_SUFFIX, "", "i");
  cleaned = replacingMatches(cleaned, UTILITY_BILL_SUFFIX, "", "i");
  cleaned = replacingMatches(cleaned, ACCOUNT_SUFFIX, "", "i");
  cleaned = trimmedForCell(replacingMatches(cleaned, "\\s+", " "));
  {
    const address = serviceAddressPrefix(cleaned);
    if (address !== null) return houseServiceAddress(fallbackHouseAddress, address) ?? address;
  }

  cleaned = replacingMatches(cleaned, METER_SUFFIX, "", "i");
  cleaned = trimmedForCell(replacingMatches(cleaned, "\\s+", " "));
  {
    const address = serviceAddressPrefix(cleaned);
    if (address !== null) return houseServiceAddress(fallbackHouseAddress, address) ?? address;
  }

  if (cleaned.length === 0 && fallback !== null) {
    cleaned = fallback;
    cleaned = replacingMatches(cleaned, PAGE_SUFFIX, "", "i");
    cleaned = replacingMatches(cleaned, ACCOUNT_SUFFIX, "", "i");
    cleaned = trimmedForCell(replacingMatches(cleaned, "\\s+", " "));
    {
      const address = serviceAddressPrefix(cleaned);
      if (address !== null) return address;
    }
    cleaned = trimmedForCell(replacingMatches(cleaned, METER_SUFFIX, "", "i"));
  }

  return houseServiceAddress(fallbackHouseAddress, cleaned) ?? cleaned;
}

function preferredHouseServiceAddress(fallback: string | null): string | null {
  if (fallback === null) return null;
  const cleaned = trimmedForCell(replacingMatches(fallback, "\\s+", " "));
  const address = serviceAddressPrefix(cleaned) ?? cleaned;
  if (!isHouseServiceAddress(address)) return null;
  return address;
}

function houseServiceAddress(houseAddress: string | null, serviceAddress: string): string | null {
  if (houseAddress === null) return null;
  const houseBase = normalizedHouseServiceAddressBase(houseAddress);
  const serviceBase = normalizedHouseServiceAddressBase(serviceAddress);
  if (houseBase.length === 0 || houseBase !== serviceBase) return null;
  return houseAddress;
}

function isHouseServiceAddress(value: string): boolean {
  const cleaned = value.toUpperCase().replace(/[^\p{L}\p{N}]+$/u, "");
  const parts = cleaned.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 0);
  const suffix = parts[parts.length - 1];
  if (suffix === undefined) return false;
  return ["HSE", "GHSE", "LDRY", "TNCT"].includes(suffix);
}

const HOUSE_BASE_REPLACEMENTS: Record<string, string> = {
  street: "st",
  str: "st",
  avenue: "ave",
  av: "ave",
  drive: "dr",
  drv: "dr",
  road: "rd",
  court: "ct",
  place: "pl",
  lane: "ln",
  boulevard: "blvd",
  circle: "cir",
  terrace: "ter",
  parkway: "pkwy",
  highway: "hwy",
};

function normalizedHouseServiceAddressBase(value: string): string {
  let cleaned = foldDiacriticsAndWidth(value).toLowerCase().trim();
  cleaned = replacingMatches(cleaned, "\\s+(?:hse|ghse|ldry|tnct)\\s*$", "", "i");
  cleaned = replacingMatches(cleaned, "[^\\p{L}\\p{N} ]+", " ", "u");
  cleaned = replacingMatches(cleaned, "\\s+", " ");
  return cleaned
    .split(" ")
    .filter((token) => token.length > 0)
    .map((token) => HOUSE_BASE_REPLACEMENTS[token] ?? token)
    .join(" ");
}

/**
 * Approximation of Swift `folding(options: [.diacriticInsensitive,
 * .widthInsensitive])`: NFKD-decompose (handles full-/half-width forms) and
 * strip combining marks.
 */
function foldDiacriticsAndWidth(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}
