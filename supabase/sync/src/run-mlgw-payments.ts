/**
 * Runnable entry — sync MLGW payment history into Supabase, once.
 *
 *   MLGW_SYNC_USERNAME=... MLGW_SYNC_PASSWORD=... RESMAN_PROPERTY_ID=... \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun run sync:mlgw-payments
 *
 * DRY RUN (recommended first): scrape + parse the live portal and print the
 * parsed rows WITHOUT writing to any database. Needs no Supabase config at all —
 * only the MLGW credentials and the property id:
 *
 *   MLGW_DRY_RUN=1 bun run sync:mlgw-payments
 *
 * ⚠ Blind port: this has never been validated against the live MLGW portal, so
 * do the dry run first and eyeball the parsed rows before writing anywhere.
 */
import { ENV } from "./config/env";
import { withLock } from "./shared/run-lock";
import { createServiceClient } from "./db/client";
import { syncMlgwPayments } from "./mlgw/jobs";

async function main(): Promise<void> {
  const env = process.env;
  const username = env[ENV.MLGW_SYNC_USERNAME]?.trim();
  const password = env[ENV.MLGW_SYNC_PASSWORD];
  const propertyId = env[ENV.RESMAN_PROPERTY_ID]?.trim();
  const dryRun = /^(1|true|yes)$/i.test(env.MLGW_DRY_RUN ?? "");
  if (!username || !password) {
    throw new Error(`Missing ${ENV.MLGW_SYNC_USERNAME} / ${ENV.MLGW_SYNC_PASSWORD}`);
  }
  if (!propertyId) {
    throw new Error(`Missing required environment variable: ${ENV.RESMAN_PROPERTY_ID}`);
  }

  // A dry run writes nothing, so it deliberately never builds a Supabase client
  // — no SUPABASE_URL / service-role key required, and no way to touch a database.
  if (dryRun) {
    console.log("[run-mlgw-payments] DRY RUN — scrape + parse only, no database writes.");
  }
  const supabase = dryRun ? null : createServiceClient(env);

  const result = await syncMlgwPayments({
    supabase,
    propertyId,
    credentials: { username, password },
    dryRun,
    log: (m) => console.log(m),
  });

  console.log("[run-mlgw-payments] complete:", JSON.stringify(result));
}

// One MLGW scraper at a time — the request ceiling is per process,
// so a second concurrent run doubles it. See shared/run-lock.ts.
withLock("mlgw", "run-mlgw-payments", main)
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("[run-mlgw-payments] failed:", error);
    process.exit(1);
  });
