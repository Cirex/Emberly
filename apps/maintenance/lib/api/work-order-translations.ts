import { z } from "zod";
import type { StaffConfig } from "@/lib/stores/config";
import type { AppLanguage } from "@/lib/i18n";

/**
 * Pre-computed work-order translations from the server.
 *
 * The sync worker translates ResMan prose once and keys it by a content hash of
 * the source — the same hash this app uses — so the phone can merge the result
 * straight into its cache instead of translating anything itself. Incremental:
 * pass the previous `syncedAt` and only rows changed since come back, so a
 * steady state costs one small request and writes nothing.
 */

const ResponseSchema = z.object({
  data: z.object({
    lang: z.string(),
    syncedAt: z.string(),
    entries: z.record(z.string(), z.string()),
    count: z.number(),
  }),
});

export interface ServerTranslations {
  /** hash → translated text, for the requested language. */
  entries: Record<string, string>;
  /** Watermark to pass as `since` next time. */
  syncedAt: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetch translations changed since `since` (omit for a full pull).
 * Throws on transport/HTTP failure — the caller treats that as "keep what we
 * have and fall back to on-device", never as an error worth showing a tech.
 */
export async function fetchWorkOrderTranslations(
  language: AppLanguage,
  since: string | null,
  config: StaffConfig,
  fetchImpl: FetchLike = fetch,
): Promise<ServerTranslations> {
  const q = new URLSearchParams({ lang: language });
  if (since) q.set("since", since);
  const res = await fetchImpl(
    `${config.baseUrl}/api/resman/work-orders/translations?${q.toString()}`,
    { headers: { Authorization: `Bearer ${config.token}` } },
  );
  if (!res.ok) throw new Error(`translations: HTTP ${res.status}`);
  const { data } = ResponseSchema.parse(await res.json());
  return { entries: data.entries, syncedAt: data.syncedAt };
}
