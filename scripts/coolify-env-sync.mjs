#!/usr/bin/env bun
/**
 * Mirror a deployable's local env file into its Coolify resource.
 *
 * Usage:
 *   bun run env:coolify <target> [options]
 *
 *   <target>          web | sync
 *   --uuid <uuid>     override the resource uuid for this run
 *   --prune           delete Coolify vars absent from the file
 *   --dry-run         show the plan, change nothing
 *   --yes, -y         skip the confirmation prompt when pruning
 *
 * Examples:
 *   bun run env:coolify sync --dry-run    # diff only, the safe first read
 *   bun run env:coolify sync              # push adds/updates
 *   bun run env:coolify web --prune       # full mirror, with confirmation
 *
 * VALUES ARE NEVER PRINTED — names and actions only, same as `env:eas`.
 *
 * WHY THIS EXISTS. Both Coolify resources were configured by typing into a web
 * form, with nothing to diff them against. That is how RESMAN_PROPERTY_ID came
 * to hold a value that produced four empty ResMan reports for a day: the sync
 * ran, authenticated, and returned zero rows, and no tool could say the
 * deployed environment disagreed with the file on disk. `--dry-run` answers
 * that question in one command.
 *
 * BUILD VARIABLES. Deployment.md §4 says to tick "Build Variable" on every
 * NEXT_PUBLIC_* line by hand, because Next.js inlines those at build time.
 * Forgetting is silent — the variable is simply undefined in the browser
 * bundle — so this sets `is_build_time` from the name instead of trusting
 * anyone to remember.
 *
 * CONFIGURATION comes from the environment, loaded from a gitignored
 * `.env.coolify` at the repo root when present:
 *
 *   COOLIFY_URL=https://coolify.example.com
 *   COOLIFY_API_TOKEN=...        # Keys & Tokens → API tokens, needs write
 *   COOLIFY_WEB_UUID=...         # resource uuid, from its Coolify URL
 *   COOLIFY_SYNC_UUID=...
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { buildPlan, countBy, formatPlan, parseEnvFile } from "./lib/env-file.mjs";

/**
 * `sync` reads `.env`, not `.env.production` — the worker's own `.env.example`
 * says to copy it to `.env`, and there is no `.env.production` in that package.
 * Getting this wrong would silently sync an empty file, so it is declared per
 * target rather than assumed.
 */
const TARGETS = {
  web: {
    envFile: "apps/web/.env.production",
    uuidVar: "COOLIFY_WEB_UUID",
    buildTime: /^NEXT_PUBLIC_/,
  },
  sync: {
    envFile: "supabase/sync/.env",
    uuidVar: "COOLIFY_SYNC_UUID",
  },
};

function usage() {
  console.error("usage: bun run env:coolify <target> [--uuid <uuid>] [--prune] [--dry-run] [--yes]");
  console.error(`  <target>  ${Object.keys(TARGETS).join(" | ")}`);
  process.exit(2);
}

function parseArgs(argv) {
  const [target, ...rest] = argv;
  if (!target) usage();
  if (!TARGETS[target]) {
    console.error(`✗ unknown target: ${target} (${Object.keys(TARGETS).join(" | ")})`);
    process.exit(2);
  }
  const opts = { target, prune: false, dryRun: false, assumeYes: false };
  for (let i = 0; i < rest.length; i += 1) {
    switch (rest[i]) {
      case "--uuid": {
        const v = rest[i + 1];
        if (!v) { console.error("✗ --uuid needs a value"); process.exit(2); }
        opts.uuid = v; i += 1; break;
      }
      case "--prune":   opts.prune = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--yes": case "-y": opts.assumeYes = true; break;
      default: console.error(`✗ unknown option: ${rest[i]}`); process.exit(2);
    }
  }
  return opts;
}

/** A Coolify env var as the API returns it. `uuid` is needed to delete it. */
/**
 * A Coolify env var as the API returns it. `uuid` is needed to delete it.
 *
 * @typedef {object} RemoteEnv
 * @property {string} uuid
 * @property {string} key
 * @property {string} value
 * @property {boolean} [is_build_time]
 */

class CoolifyClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  /** @param {string} method @param {string} endpoint @param {unknown} [body] */
  async request(method, endpoint, body) {
    return fetch(`${this.baseUrl}/api/v1${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** @param {string} appUuid @returns {Promise<RemoteEnv[]>} */
  async listEnvs(appUuid) {
    const res = await this.request("GET", `/applications/${appUuid}/envs`);
    if (!res.ok) {
      throw new Error(`GET /applications/${appUuid}/envs → ${res.status} ${res.statusText}`);
    }
    const body = await res.json();
    // Tolerate both a bare array and a { data: [...] } envelope; which one you
    // get has varied across Coolify versions.
    const rows = Array.isArray(body) ? body : (body?.data ?? []);
    return rows;
  }

  /** One call for every add and update — fewer round trips, less half-applied state. */
  /** @param {string} appUuid @param {{key: string, value: string, is_build_time: boolean}[]} entries */
  async bulkUpsert(appUuid, entries) {
    const res = await this.request("PATCH", `/applications/${appUuid}/envs/bulk`, { data: entries });
    if (!res.ok) {
      throw new Error(`PATCH /applications/${appUuid}/envs/bulk → ${res.status} ${await res.text()}`);
    }
  }

  /** @param {string} appUuid @param {string} envUuid */
  async deleteEnv(appUuid, envUuid) {
    const res = await this.request("DELETE", `/applications/${appUuid}/envs/${envUuid}`);
    if (!res.ok) {
      throw new Error(`DELETE /applications/${appUuid}/envs/${envUuid} → ${res.status} ${res.statusText}`);
    }
  }
}

async function confirm(question) {
  process.stdout.write(question);
  for await (const line of console) return /^y/i.test(line.trim());
  return false;
}

/** Load `.env.coolify` into process.env without clobbering anything already set. */
async function loadConfig(repoRoot) {
  const file = path.join(repoRoot, ".env.coolify");
  if (!existsSync(file)) return;
  for (const [key, value] of parseEnvFile(await Bun.file(file).text())) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dir, "..");
  await loadConfig(repoRoot);

  const target = TARGETS[opts.target];
  const baseUrl = process.env.COOLIFY_URL?.trim().replace(/\/+$/, "");
  const token = process.env.COOLIFY_API_TOKEN?.trim();
  const appUuid = opts.uuid ?? process.env[target.uuidVar]?.trim();

  const missing = [
    !baseUrl && "COOLIFY_URL",
    !token && "COOLIFY_API_TOKEN",
    !appUuid && `${target.uuidVar} (or --uuid)`,
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`✗ missing configuration: ${missing.join(", ")}`);
    console.error("  Set these in a gitignored .env.coolify at the repo root, or export them.");
    return 2;
  }

  const envFile = path.join(repoRoot, target.envFile);
  if (!existsSync(envFile)) {
    console.error(`✗ ${target.envFile} not found`);
    return 1;
  }
  const desired = parseEnvFile(await Bun.file(envFile).text());

  console.log(`→ ${opts.target}  ·  ${baseUrl}`);
  console.log(`  source: ${target.envFile} (${desired.size} variable(s))`);
  if (opts.dryRun) console.log("  DRY RUN — nothing will be changed");
  if (!opts.prune) console.log("  (no --prune: variables missing from the file are reported, not deleted)");
  console.log();

  const client = new CoolifyClient(baseUrl, token);
  let remoteRows;
  try {
    remoteRows = await client.listEnvs(appUuid);
  } catch (error) {
    console.error(`✗ could not read the resource's environment: ${/** @type {Error} */ (error).message}`);
    return 1;
  }

  const remote = new Map(remoteRows.map((r) => [r.key, r.value ?? ""]));
  const uuidByKey = new Map(remoteRows.map((r) => [r.key, r.uuid]));
  const plan = buildPlan(desired, remote, { prune: opts.prune });
  // Annotate with the one storage decision this script actually makes.
  const isBuildTime = (name) => target.buildTime?.test(name) ?? false;
  for (const line of formatPlan(plan, (e) =>
    (e.action === "ADD" || e.action === "UPDATE") && isBuildTime(e.name) ? "build-time" : undefined,
  )) console.log(line);

  const counts = countBy(plan);
  let deleted = 0;

  if (!opts.dryRun) {
    const upserts = plan
      .filter((e) => e.action === "ADD" || e.action === "UPDATE")
      .map((e) => ({
        key: e.name,
        value: desired.get(e.name),
        is_build_time: isBuildTime(e.name),
      }));

    if (upserts.length > 0) {
      try {
        await client.bulkUpsert(appUuid, upserts);
      } catch (error) {
        console.error(`✗ push failed: ${/** @type {Error} */ (error).message}`);
        return 1;
      }
    }

    const deletions = plan.filter((e) => e.action === "DELETE");
    if (deletions.length > 0) {
      const ok = opts.assumeYes
        || (await confirm(`\n  Delete ${deletions.length} variable(s) from ${opts.target}? [y/N] `));
      if (!ok) {
        console.log("  skipped");
      } else {
        for (const entry of deletions) {
          const envUuid = uuidByKey.get(entry.name);
          if (!envUuid) { console.error(`     ✗ no uuid for ${entry.name}, skipped`); continue; }
          try { await client.deleteEnv(appUuid, envUuid); deleted += 1; }
          catch (error) { console.error(`     ✗ failed to delete ${entry.name}: ${/** @type {Error} */ (error).message}`); }
        }
      }
    }
  }

  console.log();
  console.log("──────────────────────────────────────────────");
  console.log(
    `added ${counts.ADD} · updated ${counts.UPDATE} · unchanged ${counts.UNCHANGED} · deleted ${deleted}`,
  );
  if (!opts.prune && !opts.dryRun && counts.ORPHAN > 0) {
    console.log("Orphans left in place. Re-run with --prune to mirror the file exactly.");
  }
  if (!opts.dryRun && (counts.ADD > 0 || counts.UPDATE > 0)) {
    console.log("Redeploy the resource for the new values to take effect.");
  }
  return 0;
}

process.exit(await main());
