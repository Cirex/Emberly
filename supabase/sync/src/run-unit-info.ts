/**
 * Runnable entry — sync ResMan unit-info enrichment into Supabase, once.
 *
 *   RESMAN_SYNC_USERNAME=... RESMAN_SYNC_PASSWORD=... RESMAN_PROPERTY_ID=... \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun run sync:unit-info
 *
 * Enriches existing resman_units rows (run sync:units first to populate them)
 * and seeds resman_buildings.
 */
import { ENV } from "./config/env";
import { createServiceClient } from "./db/client";
import { ResManClient } from "./resman/client";
import { resManConfigurationFromEnv, resManCredentialsFromEnv } from "./resman/config";
import { syncUnitInfo } from "./resman/jobs/unit-info";

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

  const result = await syncUnitInfo({
    client,
    supabase,
    propertyId,
    credentials,
    log: (m) => console.log(m),
  });

  console.log("[run-unit-info] complete:", JSON.stringify(result));
}

main().catch((error) => {
  console.error("[run-unit-info] failed:", error);
  process.exit(1);
});
