/**
 * Resolve the document-list context (sessionHandle / client fields + action URL)
 * for a bill-list page, falling back to scraping the page's forms when the base
 * URL does not already carry them.
 *
 * Ports (KrakenCore/Sources/KrakenCore/Services/MLGW/MLGWBillListDocumentContext.swift):
 *   billListDocumentContext.
 *
 * `lightweightForms` / `HTMLFormShell` come from the session sibling barrel (HTML
 * form parsing is a session concern); `billDocumentId(from: fields)` maps to
 * `billDocumentIdFromFields`.
 */

import { billDocumentIdFromFields, queryFields } from "../text";
import { logProfileDuration, utf8ByteLength } from "./support";
import type { BillListDocumentContext } from "../types";
// Assumed to live in the session sibling barrel (MLGWHTMLForms).
import { lightweightForms } from "../session";

/** Faithful port of `billListDocumentContext(in:baseURL:profileLabel:sourceLabel:)`. */
export function billListDocumentContext(
  html: string,
  baseURL: URL,
  profileLabel: string | null,
  sourceLabel: string,
): BillListDocumentContext {
  const contextFields = queryFields(baseURL);
  let actionURL = baseURL;

  const sessionHandleMissing = (contextFields["sessionHandle"] ?? "").length === 0;
  const clientMissing = (contextFields["client"] ?? "").length === 0;
  if (sessionHandleMissing || clientMissing) {
    const formsStartedAt = profileLabel === null ? null : Date.now();
    const forms = lightweightForms(html, baseURL);
    if (profileLabel !== null && formsStartedAt !== null) {
      logProfileDuration(
        `${profileLabel} ${sourceLabel} form context`,
        formsStartedAt,
        `forms=${forms.length} bytes=${utf8ByteLength(html)}`,
      );
    }

    const form =
      forms.find((candidate) => {
        const action = (candidate.fields["action"] ?? "").toLowerCase();
        return (
          action.includes("multipaydocumentlist") ||
          action.includes("archivedocumentlist") ||
          action.includes("documentlist") ||
          billDocumentIdFromFields(candidate.fields) !== null
        );
      }) ??
      forms.find(
        (candidate) =>
          candidate.fields["sessionHandle"] !== undefined && candidate.fields["client"] !== undefined,
      ) ??
      forms[0];

    actionURL = form?.action ?? baseURL;
    if (form !== undefined) {
      for (const key of ["sessionHandle", "client"]) {
        if ((contextFields[key] ?? "").length === 0) {
          const value = form.fields[key];
          if (value !== undefined && value.length > 0) {
            contextFields[key] = value;
          }
        }
      }
    }
  }

  return {
    fields: contextFields,
    actionURL,
    hasDocumentContext:
      (contextFields["sessionHandle"] ?? "").length > 0 && (contextFields["client"] ?? "").length > 0,
  };
}
