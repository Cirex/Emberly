import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

/**
 * Apply Supabase SQL migrations against the database in SUPABASE_DB_URL.
 *
 * Usage:
 *   # every not-yet-applied migration in lib/supabase/deltas, in filename order:
 *   SUPABASE_DB_URL=... bun scripts/apply-supabase-migrations.mjs
 *
 *   # or specific files:
 *   SUPABASE_DB_URL=... bun scripts/apply-supabase-migrations.mjs path/to/one.sql
 *
 *   # production, loading the URL from a gitignored env file:
 *   bun --env-file=.env.production scripts/apply-supabase-migrations.mjs
 *
 * Each migration runs once — a public.schema_migrations ledger records what has
 * been applied, and each file runs inside its own transaction (rolled back on
 * error), so re-running is always safe.
 */

/**
 * Migrations live in `deltas/`, NOT the older `migrations/` — this pointed at
 * the latter, which has been empty since 2026-07-20, so a bare `db:migrate`
 * printed "No migrations to apply" no matter what was pending. Every delta was
 * therefore applied by naming the file explicitly, and four of them
 * (guest-pass unit bans + expiry, work-order translations, utility run styles)
 * reached the database without ever getting a ledger row. Reconciled and
 * repointed on 2026-07-25.
 */
const MIGRATIONS_DIR = path.join(import.meta.dir, "..", "lib", "supabase", "deltas");

if (!process.env.SUPABASE_DB_URL) {
  throw new Error(
    "SUPABASE_DB_URL is required — set it in the env file you pass via --env-file, or export it.",
  );
}

const argFiles = process.argv.slice(2);
const files =
  argFiles.length > 0
    ? argFiles
    : fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .map((f) => path.join(MIGRATIONS_DIR, f));

// Deltas are KEPT after applying (unlike the old migrations/ convention, which
// deleted them once folded into schema.sql), so the directory is normally
// non-empty and the ledger — not the filesystem — decides what still runs.
if (files.length === 0) {
  console.log("No migrations to apply.");
  process.exit(0);
}

/**
 * Resolve the SSL setting. Managed Postgres wants TLS (we don't verify the CA,
 * matching Supabase's self-signed cert); many self-hosted / Coolify Postgres
 * containers don't terminate TLS at all. Disable it with `?sslmode=disable` on
 * the URL, or SUPABASE_DB_SSL=disable.
 */
function resolveSsl(connectionString) {
  const off = new Set(["disable", "false", "0", "off", "no"]);
  const flag = process.env.SUPABASE_DB_SSL?.trim().toLowerCase();
  if (flag) return off.has(flag) ? false : { rejectUnauthorized: false };
  try {
    if (off.has(new URL(connectionString).searchParams.get("sslmode") ?? "")) return false;
  } catch {
    /* not a parseable URL — fall through to the TLS default */
  }
  return { rejectUnauthorized: false };
}

const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: resolveSsl(process.env.SUPABASE_DB_URL),
});

await client.connect();

try {
  await client.query(`
    create table if not exists public.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  // RLS on, no policies — the same "service-role only" posture as every table
  // in schema.sql, and it is NOT optional here. Supabase grants anon and
  // authenticated full CRUD on the exposed `public` schema by default and this
  // project has never revoked those grants, so RLS is the only barrier: without
  // this line the ledger was readable and WRITABLE with the project's anon key,
  // and deleting a row silently re-runs a migration. The service role bypasses
  // RLS, so this script (and everything else) is unaffected.
  // Idempotent — enabling it twice is a no-op.
  await client.query("alter table public.schema_migrations enable row level security;");

  const { rows } = await client.query("select name from public.schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  let ran = 0;
  for (const file of files) {
    const name = path.basename(file);
    if (applied.has(name)) {
      console.log(`Skipping ${name} (already applied)`);
      continue;
    }
    console.log(`Applying ${name}`);
    const sql = fs.readFileSync(file, "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into public.schema_migrations (name) values ($1)", [name]);
      await client.query("commit");
      ran += 1;
    } catch (error) {
      await client.query("rollback");
      throw new Error(`Migration ${name} failed (rolled back): ${error.message}`);
    }
  }

  console.log(ran === 0 ? "Already up to date." : `Applied ${ran} migration(s).`);
} finally {
  await client.end();
}
