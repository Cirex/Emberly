import { NextResponse } from "next/server";
import { requireResmanApiKey } from "@/lib/resman-api-auth";
import { createUntypedAdminClient } from "@/lib/supabase/admin";

/**
 * Pre-computed translations of work-order prose, for the maintenance app.
 *
 * The sync worker translates ResMan prose once (supabase/sync
 * translate-work-orders) and stores it keyed by a content hash of the source —
 * the SAME hash the device uses. The app merges this response straight into its
 * on-device cache, so a phone never re-translates prose the server already did.
 *
 * Incremental by design: pass `since` (the `syncedAt` from the previous
 * response) and only rows changed after it come back. A steady state where
 * nothing changed returns an empty map, which is the whole point — an unchanged
 * corpus must not re-download or re-translate on every sync.
 */

/** PostgREST caps a response at 1000 rows, so the read pages. */
const PAGE = 1000;

const SUPPORTED = new Set(["en", "es"]);

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await requireResmanApiKey(request);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const lang = (searchParams.get("lang") ?? "").trim().toLowerCase();
  if (!SUPPORTED.has(lang)) {
    return NextResponse.json({ error: "lang must be one of: en, es" }, { status: 400 });
  }
  const since = searchParams.get("since")?.trim();

  try {
    const supabase = createUntypedAdminClient();
    // Stamped before the read: any row written during it carries an updated_at
    // at or after this, so the next incremental pull picks it up rather than
    // skipping it. Overlap is harmless (the merge is idempotent); a gap isn't.
    const syncedAt = new Date().toISOString();

    const entries: Record<string, string> = {};
    for (let from = 0; ; from += PAGE) {
      let query = supabase
        .from("work_order_translations")
        .select("source_hash, translated_text, updated_at")
        .eq("target_lang", lang)
        .order("updated_at", { ascending: true })
        // updated_at is NOT unique — one sync pass stamps hundreds of rows in
        // the same millisecond — and offset paging over a tied sort is
        // non-deterministic, so a tied row lands on two pages while its
        // neighbour lands on none. source_hash is the primary key under the
        // target_lang filter, so ending on it makes the sort total. Without it
        // the device silently never learns about the skipped translations, and
        // a content-addressed cache has no way to notice the gap.
        .order("source_hash", { ascending: true })
        .range(from, from + PAGE - 1);
      if (since) query = query.gt("updated_at", since);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const row of data) entries[row.source_hash] = row.translated_text;
      if (data.length < PAGE) break;
    }

    return NextResponse.json({
      data: { lang, syncedAt, entries, count: Object.keys(entries).length },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load translations" },
      { status: 500 },
    );
  }
}
