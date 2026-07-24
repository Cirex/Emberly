/**
 * Runnable entry — pre-translate work-order prose into work_order_translations,
 * once. Runs after sync:work-orders (the prose must be in the mirror first).
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   LANGBLY_API_KEY=... [LANGBLY_API_URL=...] \
 *   bun run sync:translate-work-orders
 *
 * With no LANGBLY_API_KEY the job no-ops cleanly, so it's safe to wire into the
 * pipeline before the key is provisioned.
 */
import { createServiceClient } from "./db/client";
import { langblyFromEnv } from "./shared/langbly";
import { translateWorkOrders } from "./resman/jobs/translate-work-orders";

async function main(): Promise<void> {
  const env = process.env;
  const supabase = createServiceClient(env);
  const translator = langblyFromEnv(env);

  const result = await translateWorkOrders({
    supabase,
    translator,
    log: (m) => console.log(m),
  });

  console.log("[run-translate-work-orders] complete:", JSON.stringify(result));
}

main().catch((error) => {
  console.error("[run-translate-work-orders] failed:", error);
  process.exit(1);
});
