/**
 * Runnable entry — sync MLGW payment history into Supabase, once.
 *
 *   MLGW_SYNC_USERNAME=... MLGW_SYNC_PASSWORD=... RESMAN_PROPERTY_ID=... \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun run sync:mlgw-payments
 *
 * ⚠ Blind port: never run against the live MLGW portal.
 */
import { ENV } from "./config/env";
import { createServiceClient } from "./db/client";
import { syncMlgwPayments } from "./mlgw/jobs";

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
  const supabase = createServiceClient(env);

  const result = await syncMlgwPayments({
    supabase,
    propertyId,
    credentials: { username, password },
    log: (m) => console.log(m),
  });

  console.log("[run-mlgw-payments] complete:", JSON.stringify(result));
}

main().catch((error) => {
  console.error("[run-mlgw-payments] failed:", error);
  process.exit(1);
});
