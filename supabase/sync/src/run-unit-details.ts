/**
 * Runnable entry — deep-scrape ResMan unit details into Supabase, once.
 *
 *   RESMAN_SYNC_USERNAME=... RESMAN_SYNC_PASSWORD=... RESMAN_PROPERTY_ID=... \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   RESMAN_UNIT_LIMIT=5 bun run sync:unit-details
 *
 * Scrapes each unit's detail page + lease history + ledger + residents/tabs and
 * upserts resman_leases / resman_transactions / resman_residents / resman_lease_*.
 * Set RESMAN_UNIT_LIMIT to scrape only the first N units (recommended for a first
 * run — a full sweep hits ResMan once per unit).
 */
import { ENV } from "./config/env";
import { withLock } from "./shared/run-lock";
import { createServiceClient } from "./db/client";
import { ResManClient } from "./resman/client";
import { resManConfigurationFromEnv, resManCredentialsFromEnv } from "./resman/config";
import { syncUnitDetails } from "./resman/jobs/unit-detail";

async function main(): Promise<void> {
  const env = process.env;
  const propertyId = env[ENV.RESMAN_PROPERTY_ID]?.trim();
  if (!propertyId) {
    throw new Error(`Missing required environment variable: ${ENV.RESMAN_PROPERTY_ID}`);
  }
  const intEnv = (key: string): number | undefined => {
    const raw = env[key]?.trim();
    return raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
  };
  const unitLimit = intEnv("RESMAN_UNIT_LIMIT");
  // RESMAN_CONNECTIONS_PER_HOST raises the real request ceiling (the scheduler);
  // the worker pool defaults to match it so bumping one knob is enough.
  const connectionsPerHost = intEnv("RESMAN_CONNECTIONS_PER_HOST");
  const concurrency = intEnv("RESMAN_UNIT_CONCURRENCY") ?? connectionsPerHost;

  const configuration = resManConfigurationFromEnv(env);
  const credentials = resManCredentialsFromEnv(env);
  const supabase = createServiceClient(env);
  const client = new ResManClient(configuration, {
    credentials,
    connectionsPerHost,
    log: (m) => console.log(m),
  });

  const result = await syncUnitDetails({
    client,
    supabase,
    propertyId,
    credentials,
    unitLimit,
    concurrency,
    log: (m) => console.log(m),
  });

  console.log("[run-unit-details] complete:", JSON.stringify(result));
}

// One RESMAN scraper at a time — the request ceiling is per process,
// so a second concurrent run doubles it. See shared/run-lock.ts.
withLock("resman", "run-unit-details", main)
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("[run-unit-details] failed:", error);
    process.exit(1);
  });
