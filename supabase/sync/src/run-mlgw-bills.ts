/**
 * Runnable entry — sync MLGW bills into Supabase, once.
 *
 *   MLGW_SYNC_USERNAME=... MLGW_SYNC_PASSWORD=... RESMAN_PROPERTY_ID=... \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun run sync:mlgw-bills
 *
 * MLGW_PROPERTY_NAME is optional (a label on imported bills); it defaults to
 * RESMAN_PROPERTY_ID.
 *
 * ⚠ Blind port: never run against the live MLGW portal. Expect the PDF-text seam
 * to be unimplemented until a PDF text library is wired in.
 */
import { ENV } from "./config/env";
import { withLock } from "./shared/run-lock";
import { createServiceClient } from "./db/client";
import { syncMlgwBills } from "./mlgw/jobs";

async function main(): Promise<void> {
  const env = process.env;
  const username = env[ENV.MLGW_SYNC_USERNAME]?.trim();
  const password = env[ENV.MLGW_SYNC_PASSWORD];
  const propertyId = env[ENV.RESMAN_PROPERTY_ID]?.trim();
  if (!username || !password) {
    throw new Error(`Missing ${ENV.MLGW_SYNC_USERNAME} / ${ENV.MLGW_SYNC_PASSWORD}`);
  }
  if (!propertyId) {
    throw new Error(`Missing required environment variable: ${ENV.RESMAN_PROPERTY_ID}`);
  }
  // MLGW_PROPERTY_NAME is only stored as a label on imported bills (never used to
  // match), so it defaults to the ResMan property id when unset.
  const propertyName = env["MLGW_PROPERTY_NAME"]?.trim() || propertyId;
  const supabase = createServiceClient(env);

  const result = await syncMlgwBills({
    supabase,
    propertyId,
    propertyName,
    credentials: { username, password },
    log: (m) => console.log(m),
  });

  console.log("[run-mlgw-bills] complete:", JSON.stringify(result));
}

// One MLGW scraper at a time — the request ceiling is per process,
// so a second concurrent run doubles it. See shared/run-lock.ts.
withLock("mlgw", "run-mlgw-bills", main)
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("[run-mlgw-bills] failed:", error);
    process.exit(1);
  });
