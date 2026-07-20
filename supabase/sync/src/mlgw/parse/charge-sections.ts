/**
 * Port of KrakenCore/Services/MLGW/MLGWChargeSections.swift.
 *
 * Isolates the region of a bill's text that holds the itemized meter/charge
 * detail — preferring an explicit "Detailed Charges" heading, else the first
 * page's `Readings Usage Amount Total` band, and appending any
 * `CURRENT CHARGES (continued)` block. (This file is not in the parse group's
 * explicit ownership list but is required by `parseCharges` and belongs to the
 * parse layer, so it is ported here.)
 */

import { endOfMatch, indexOfMatch } from "./charge-text";

/** Faithful port of `currentChargesSection(from:)`. */
export function currentChargesSection(text: string): string {
  const detailedStart = text.toLowerCase().indexOf("detailed charges");
  if (detailedStart >= 0) return text.slice(detailedStart);

  const pageBreak = indexOfMatch(text, "[\\n\\f]Page\\s+2\\s+of\\s+[0-9]+", "i");
  const firstPage = pageBreak >= 0 ? text.slice(0, pageBreak) : text;

  let start = endOfMatch(firstPage, "Readings\\s+Usage\\s+Amount\\s+Total", "i");
  if (start < 0) {
    const electric = firstPage.toLowerCase().indexOf("electric");
    start = electric >= 0 ? electric : 0;
  }
  let end = indexOfMatch(
    firstPage,
    "\\n\\s*(?:If paying in person|Please detach|DO NOT USE STAPLES|LATE FEE ALLOWANCES)",
    "i",
  );
  if (end < 0) end = firstPage.length;
  const firstPageSection = start <= end ? firstPage.slice(start, end) : firstPage;

  const continuedStart = indexOfMatch(text, "CURRENT\\s+CHARGES\\s*\\(\\s*continued\\s*\\)", "i");
  if (continuedStart < 0) return firstPageSection;
  const continuedText = text.slice(continuedStart);
  let continuedEnd = indexOfMatch(continuedText, "\\n\\s*Total\\s+Current\\s+Charges\\b", "i");
  if (continuedEnd < 0) continuedEnd = continuedText.length;
  return firstPageSection + "\n" + continuedText.slice(0, continuedEnd);
}
