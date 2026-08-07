/**
 * Runnable entry — sync ResMan available-units enrichment into Supabase, once.
 *
 *   RESMAN_SYNC_USERNAME=... RESMAN_SYNC_PASSWORD=... RESMAN_PROPERTY_ID=... \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun run sync:available-units
 *
 * Enriches existing resman_units rows (run sync:units first to populate them).
 */
import { ENV } from "./config/env";
import { withLock } from "./shared/run-lock";
import { createServiceClient } from "./db/client";
import { ResManClient } from "./resman/client";
import { resManConfigurationFromEnv, resManCredentialsFromEnv } from "./resman/config";
import { syncAvailableUnits } from "./resman/jobs/available-units";

async function main(): Promise<void> {
  const env = process.env;
  const propertyId = env[ENV.RESMAN_PROPERTY_ID]?.trim();
  if (!propertyId) {
    throw new Error(`Missing required environment variable: ${ENV.RESMAN_PROPERTY_ID}`);
  }

  const configuration = resManConfigurationFromEnv(env);
  const credentials = resManCredentialsFromEnv(env);
  const supabase = createServiceClient(env);
  const client = new ResManClient(configuration, {
    credentials,
    log: (m) => console.log(m),
  });

  const result = await syncAvailableUnits({
    client,
    supabase,
    propertyId,
    credentials,
    log: (m) => console.log(m),
  });

  console.log("[run-available-units] complete:", JSON.stringify(result));
}

// One RESMAN scraper at a time — the request ceiling is per process,
// so a second concurrent run doubles it. See shared/run-lock.ts.
withLock("resman", "run-available-units", main)
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("[run-available-units] failed:", error);
    process.exit(1);
  });
