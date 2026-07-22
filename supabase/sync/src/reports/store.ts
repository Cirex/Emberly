/**
 * Storage layout + helpers for the owner-report bucket.
 *
 * Layout (private `owner-reports` bucket, provisioned by emberly-web's
 * schema.sql / deltas/2026-07-22-owner-reports.sql):
 *
 *   <YYYY-MM>.pdf   — the rendered Letter report (may be absent when Chromium
 *                     was unavailable at generation time; the web API then
 *                     falls back to streaming the HTML).
 *   <YYYY-MM>.html  — the exact HTML the PDF was (or will be) rendered from.
 *   <YYYY-MM>.json  — the FROZEN ReportFigures payload ("report numbers
 *                     freeze"). Written LAST: its presence marks the report
 *                     complete, drives run idempotency, and feeds the
 *                     manager-app list summaries.
 */

import type { ServiceClient } from "../db/client";

export const OWNER_REPORTS_BUCKET = "owner-reports";

export interface OwnerReportPaths {
  pdf: string;
  html: string;
  json: string;
}

/** Object names for one period — flat bucket, period-stamped stems. */
export function ownerReportPaths(period: string): OwnerReportPaths {
  return { pdf: `${period}.pdf`, html: `${period}.html`, json: `${period}.json` };
}

/** True when the period's frozen-figures JSON already exists (report done). */
export async function ownerReportExists(client: ServiceClient, period: string): Promise<boolean> {
  const target = ownerReportPaths(period).json;
  const { data, error } = await client.storage
    .from(OWNER_REPORTS_BUCKET)
    .list("", { search: target, limit: 100 });
  if (error) throw new Error(`list ${OWNER_REPORTS_BUCKET} failed: ${error.message}`);
  return (data ?? []).some((entry) => entry.name === target);
}

/** Upload one object; throws on failure (a partial report must fail loud). */
export async function uploadOwnerReportObject(
  client: ServiceClient,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const { error } = await client.storage
    .from(OWNER_REPORTS_BUCKET)
    .upload(path, new Blob([bytes as unknown as ArrayBuffer], { type: contentType }), {
      contentType,
      upsert: true,
    });
  if (error) throw new Error(`upload ${path} to ${OWNER_REPORTS_BUCKET} failed: ${error.message}`);
}
