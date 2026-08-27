/**
 * Runnable entry — flush queued maintenance work-order edits/closes to ResMan.
 *
 *   RESMAN_SYNC_USERNAME=... RESMAN_SYNC_PASSWORD=... RESMAN_PROPERTY_ID=... \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun run sync:flush-work-order-writes
 *
 * Drains `maintenance_work_order_edits` (written by the web app's
 * /api/resman/work-orders/[id]/edit|close routes) through the form-replay
 * writer. Run it often — a technician is watching their outbox. It exits
 * quickly when the queue is empty (one Supabase read, no ResMan traffic).
 */
import { ENV } from "./config/env";
import { withLock } from "./shared/run-lock";
import { createServiceClient } from "./db/client";
import { ResManClient } from "./resman/client";
import { resManConfigurationFromEnv, resManCredentialsFromEnv } from "./resman/config";
import { flushWorkOrderWrites } from "./resman/jobs/flush-work-order-writes";

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

  const result = await flushWorkOrderWrites({
    client,
    supabase,
    propertyId,
    credentials,
    log: (m) => console.log(m),
  });

  console.log("[run-flush-work-order-writes] complete:", JSON.stringify(result));
}

// One ResMan actor at a time — a write must never race a scrape for the
// request ceiling (and a scrape's session refresh must never race a write).
withLock("resman", "run-flush-work-order-writes", main)
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("[run-flush-work-order-writes] failed:", error);
    process.exit(1);
  });
