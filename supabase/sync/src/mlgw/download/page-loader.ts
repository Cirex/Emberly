/**
 * Bill-list page fetch + target dedup key. Ports of
 * KrakenCore/Services/MLGW/MLGWBillListPageLoader.swift and MLGWBillTargetKeys.swift
 * (two standalone helpers). GET/POST a list page with the workspace referer and
 * transient-network retries; key a target by method+url+sorted fields+documentId.
 */
import { configuredHTTPTimeout } from "../env";
import { type MLGWHTTPClient, withTransientNetworkRetries } from "../http";
import { queryFields } from "../text";
import type { BillTarget, HTTPResponse, MLGWScriptCancellation } from "../types";
import { billingWorkspaceRefererURL } from "./targets";

/** Stable dedup key for a bill target. Port of `billTargetKey`. */
export function billTargetKey(target: BillTarget): string {
  const fields = Object.keys(target.fields)
    .sort()
    .map((key) => `${key}=${target.fields[key] ?? ""}`)
    .join("&");
  return `${target.method}|${target.url.toString()}|${fields}|documentId=${target.documentId ?? ""}`;
}

function formURLEncoded(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** Fetch one bill-list page (GET or form POST) with retries. Port of `fetchBillListPage`. */
export async function fetchBillListPage(
  target: BillTarget,
  client: MLGWHTTPClient,
  cancellation?: MLGWScriptCancellation,
): Promise<HTTPResponse> {
  const timeout = configuredHTTPTimeout("MLGW_BILL_LIST_REQUEST_TIMEOUT", 60_000);
  const qf = queryFields(target.url);
  const startPos = qf["startPos"] ?? target.fields["startPos"] ?? "unknown";
  const pageSize = qf["pageSize"] ?? target.fields["pageSize"] ?? "unknown";
  return withTransientNetworkRetries(
    async () => {
      const referer = billingWorkspaceRefererURL(target.url)?.toString() ?? target.url.toString();
      const headers: Record<string, string> = {
        Accept: "text/html, */*; q=0.01",
        Referer: referer,
        "X-Requested-With": "XMLHttpRequest",
      };
      if (target.method === "GET") {
        return client.request("GET", target.url, { headers, timeoutMs: timeout });
      }
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      return client.request("POST", target.url, {
        headers,
        body: formURLEncoded(target.fields),
        timeoutMs: timeout,
      });
    },
    { maxAttempts: 3, cancellation, debugLabel: `MLGW list page startPos ${startPos}, pageSize ${pageSize}` },
  );
}
