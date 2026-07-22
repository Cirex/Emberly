/**
 * Runnable entry — detect and push the manager app's operational alerts, once.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun run sync:manager-alerts
 *
 * Reads only the already-synced mirror tables (no ResMan/MLGW scraping), so
 * schedule it AFTER the sync pipeline — it can otherwise run on its own short
 * interval as often as alerts should be allowed to arrive.
 *
 * Optional environment:
 *   MANAGER_ALERT_BALANCE_THRESHOLD  balance crossing point, dollars (default 1500)
 *   MANAGER_ALERT_DRY_RUN=1          detect and log without claiming or sending
 */
import { createServiceClient } from "./db/client";
import { syncManagerAlerts } from "./manager/alerts";

function optionalNumber(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`MANAGER_ALERT_BALANCE_THRESHOLD must be a positive number, got "${raw}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const env = process.env;
  const supabase = createServiceClient(env);

  const result = await syncManagerAlerts({
    supabase,
    balanceThreshold: optionalNumber(env.MANAGER_ALERT_BALANCE_THRESHOLD),
    dryRun: env.MANAGER_ALERT_DRY_RUN === "1",
    log: (m) => console.log(m),
  });

  console.log("[run-manager-alerts] complete:", JSON.stringify(result));
}

main().catch((error) => {
  console.error("[run-manager-alerts] failed:", error);
  process.exit(1);
});
