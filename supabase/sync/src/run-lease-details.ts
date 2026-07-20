/**
 * Runnable entry — deep-scrape ResMan lease details (ledger + residents + tabs), once.
 *
 *   RESMAN_SYNC_USERNAME=... RESMAN_SYNC_PASSWORD=... RESMAN_PROPERTY_ID=... \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   RESMAN_LEASE_LIMIT=5 bun run sync:lease-details
 *
 * Iterates the property's current/most-recent leases (populated by
 * sync:unit-details) and deep-scrapes each: full lease fields + ledger
 * (resman_transactions) + residents with per-person tabs (resman_residents +
 * resman_lease_*). Set RESMAN_LEASE_LIMIT to scrape only the first N leases.
 */
import { ENV } from "./config/env";
import { createServiceClient } from "./db/client";
import { ResManClient } from "./resman/client";
import { resManConfigurationFromEnv, resManCredentialsFromEnv } from "./resman/config";
import { syncLeaseDetails } from "./resman/jobs/unit-detail";

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
  const leaseLimit = intEnv("RESMAN_LEASE_LIMIT");
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

  const result = await syncLeaseDetails({
    client,
    supabase,
    propertyId,
    credentials,
    leaseLimit,
    concurrency,
    log: (m) => console.log(m),
  });

  console.log("[run-lease-details] complete:", JSON.stringify(result));
}

main().catch((error) => {
  console.error("[run-lease-details] failed:", error);
  process.exit(1);
});
