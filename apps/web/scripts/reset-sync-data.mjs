import { Client } from "pg";

/**
 * Reset the ResMan/MLGW sync-mirror tables so the sync worker can repopulate
 * from scratch. Manually-authored data (unit_tags, map_cameras, annotations,
 * scanner_devices, admin_users, residents, access_tokens) is NEVER touched —
 * those tables link to units by text/coords, not by FK, so nothing cascades.
 *
 *   COUNT ONLY (default, read-only):
 *     bun --env-file=.env.production scripts/reset-sync-data.mjs
 *   ACTUALLY WIPE:
 *     bun --env-file=.env.production scripts/reset-sync-data.mjs --wipe
 */

// Ordered children-before-parents; TRUNCATE ... RESTART IDENTITY handles the
// rest. resman_sync_runs is the run log — wiped too for a clean slate.
const MIRROR_TABLES = [
  "resman_transactions",
  "resman_lease_vehicles",
  "resman_lease_employment",
  "resman_lease_insurance",
  "resman_lease_addresses",
  "resman_lease_alternate_contacts",
  "resman_leases",
  "resman_residents",
  "resman_work_orders",
  "resman_units",
  "resman_floorplans",
  "resman_buildings",
  "resman_properties",
  "resman_sync_state",
  "resman_sync_runs",
  "mlgw_payments",
  "mlgw_bills",
  "mlgw_accounts",
];

// Shown for reassurance — verified present and untouched.
const PRESERVED_TABLES = [
  "unit_tags",
  "map_cameras",
  "map_annotation_layers",
  "scanner_devices",
  "admin_users",
  "residents",
];

const WIPE = process.argv.includes("--wipe");

if (!process.env.SUPABASE_DB_URL) {
  throw new Error("SUPABASE_DB_URL is required (pass --env-file=.env.production).");
}

function resolveSsl(connectionString) {
  const off = new Set(["disable", "false", "0", "off", "no"]);
  const flag = process.env.SUPABASE_DB_SSL?.trim().toLowerCase();
  if (flag) return off.has(flag) ? false : { rejectUnauthorized: false };
  try {
    if (off.has(new URL(connectionString).searchParams.get("sslmode") ?? "")) return false;
  } catch {
    /* not a URL */
  }
  return { rejectUnauthorized: false };
}

const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: resolveSsl(process.env.SUPABASE_DB_URL),
});

async function count(table) {
  try {
    const { rows } = await client.query(`select count(*)::int as n from public.${table}`);
    return rows[0].n;
  } catch (e) {
    return `(missing: ${e.message.split("\n")[0]})`;
  }
}

await client.connect();
try {
  console.log(`\n=== MIRROR tables (${WIPE ? "will be WIPED" : "count only"}) ===`);
  for (const t of MIRROR_TABLES) console.log(`  ${t.padEnd(34)} ${await count(t)}`);

  console.log(`\n=== PRESERVED tables (never touched) ===`);
  for (const t of PRESERVED_TABLES) console.log(`  ${t.padEnd(34)} ${await count(t)}`);

  if (!WIPE) {
    console.log("\nRead-only. Re-run with --wipe to truncate the mirror tables.\n");
  } else {
    console.log("\nTruncating mirror tables...");
    await client.query(
      `truncate table ${MIRROR_TABLES.map((t) => `public.${t}`).join(", ")} restart identity`,
    );
    console.log("Done. Re-counting mirror tables:");
    for (const t of MIRROR_TABLES) console.log(`  ${t.padEnd(34)} ${await count(t)}`);
    console.log("\nPreserved tables after wipe:");
    for (const t of PRESERVED_TABLES) console.log(`  ${t.padEnd(34)} ${await count(t)}`);
    console.log();
  }
} finally {
  await client.end();
}
