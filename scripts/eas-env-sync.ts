#!/usr/bin/env bun
/**
 * Mirror an app's local `.env.production` into its EAS environments — including
 * REMOVING variables that no longer exist in the file.
 *
 * Usage:
 *   bun scripts/eas-env-sync.ts <app-dir> [options]
 *
 *   --environments "production preview"   which EAS environments (default both)
 *   --prune                               delete EAS vars absent from the file
 *   --dry-run                             show the plan, change nothing
 *   --yes, -y                             skip the confirmation prompt when pruning
 *
 * Examples:
 *   bun scripts/eas-env-sync.ts apps/security --dry-run   # diff only, the safe read
 *   bun scripts/eas-env-sync.ts apps/security             # push adds/updates
 *   bun scripts/eas-env-sync.ts apps/security --prune     # full mirror, with confirmation
 *
 * VALUES ARE NEVER PRINTED. The plan shows variable names and an action only,
 * so it is safe to paste into a ticket or read over a shared screen.
 *
 * Ported from eas-env-sync.sh. The behaviour is unchanged; what went away is
 * the bash-3.2 scaffolding the old version needed to run on stock macOS — the
 * temp-file "associative arrays", the `grep -v | mv` rewrite per key to get
 * last-assignment-wins, and the quoting hazards of building an argv in a
 * string. Parsing now lives in lib/env-file.ts, shared with the Coolify sync so
 * the two cannot drift.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import path from "node:path";

import { buildPlan, countBy, formatPlan, parseEnvFile, type EnvMap } from "./lib/env-file";

interface Options {
  app: string;
  environments: string[];
  prune: boolean;
  dryRun: boolean;
  assumeYes: boolean;
}

const USAGE =
  'usage: bun scripts/eas-env-sync.ts <app-dir> [--environments "production preview"] [--prune] [--dry-run] [--yes]';

function parseArgs(argv: string[]): Options {
  const [app, ...rest] = argv;
  if (!app || app.startsWith("--")) {
    console.error(USAGE);
    process.exit(2);
  }
  const opts: Options = {
    app: app.replace(/\/+$/, ""),
    environments: ["production", "preview"],
    prune: false,
    dryRun: false,
    assumeYes: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    switch (rest[i]) {
      case "--environments": {
        const value = rest[i + 1];
        if (!value) { console.error("✗ --environments needs a value"); process.exit(2); }
        opts.environments = value.split(/\s+/).filter(Boolean);
        i += 1;
        break;
      }
      case "--prune":   opts.prune = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--yes":
      case "-y":        opts.assumeYes = true; break;
      default:
        console.error(`✗ unknown option: ${rest[i]}`);
        process.exit(2);
    }
  }
  return opts;
}

/** `eas` if it is on PATH, else `bunx eas-cli` — same probe as the shell version. */
async function resolveEas(): Promise<string[]> {
  const found = await $`command -v eas`.nothrow().quiet();
  return found.exitCode === 0 ? ["eas"] : ["bunx", "eas-cli"];
}

/**
 * EAS returns secret values as a placeholder rather than the value, so equality
 * can never be proven for them and they always read as an UPDATE. Harmless —
 * `env:create --force` is idempotent — but it must not be misread as a change.
 */
const isMaskedSecret = (value: string) => value.includes("This is a secret env variable");

async function readRemote(eas: string[], cwd: string, environment: string): Promise<EnvMap> {
  const [bin, ...pre] = eas;
  const result = await $`${bin} ${pre} env:list --environment ${environment} --format short`
    .cwd(cwd).nothrow().quiet();
  // A brand-new environment exits non-zero / prints nothing; that is "empty",
  // not an error — the same tolerance the shell version had via `|| : >`.
  return result.exitCode === 0 ? parseEnvFile(result.stdout.toString()) : new Map();
}

async function confirm(question: string): Promise<boolean> {
  process.stdout.write(question);
  for await (const line of console) return /^y/i.test(line.trim());
  return false;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dir, "..");
  const appDir = path.resolve(repoRoot, opts.app);
  const envFile = path.join(appDir, ".env.production");

  if (!existsSync(appDir)) { console.error(`✗ no such app directory: ${opts.app}`); return 1; }
  if (!existsSync(envFile)) { console.error(`✗ ${opts.app}/.env.production not found`); return 1; }

  const desired = parseEnvFile(await Bun.file(envFile).text());
  const eas = await resolveEas();

  console.log(`→ ${opts.app}  ·  environments: ${opts.environments.join(" ")}`);
  console.log(`  source: ${opts.app}/.env.production (${desired.size} variable(s))`);
  if (opts.dryRun) console.log("  DRY RUN — nothing will be changed");
  if (!opts.prune) console.log("  (no --prune: variables missing from the file are reported, not deleted)");
  console.log();

  const totals = { ADD: 0, UPDATE: 0, UNCHANGED: 0, DELETE: 0 };
  let exitCode = 0;

  for (const environment of opts.environments) {
    console.log(`── ${environment} ─────────────────────────────────`);
    const remote = await readRemote(eas, appDir, environment);
    const plan = buildPlan(desired, remote, { prune: opts.prune, remoteMasksSecrets: isMaskedSecret });
    for (const line of formatPlan(plan)) console.log(line);

    const counts = countBy(plan);
    totals.ADD += counts.ADD;
    totals.UPDATE += counts.UPDATE;
    totals.UNCHANGED += counts.UNCHANGED;

    if (!opts.dryRun) {
      const [bin, ...pre] = eas;
      for (const entry of plan) {
        if (entry.action !== "ADD" && entry.action !== "UPDATE") continue;
        const value = desired.get(entry.name)!;
        const push = await $`${bin} ${pre} env:create --environment ${environment} --name ${entry.name} --value ${value} --visibility ${entry.visibility!} --force --non-interactive`
          .cwd(appDir).nothrow().quiet();
        if (push.exitCode !== 0) { console.error(`     ✗ failed to push ${entry.name}`); exitCode = 1; }
      }

      const deletions = plan.filter((e) => e.action === "DELETE");
      if (deletions.length > 0) {
        const ok = opts.assumeYes
          || (await confirm(`\n  Delete ${deletions.length} variable(s) from ${environment}? [y/N] `));
        if (!ok) {
          console.log("  skipped");
        } else {
          for (const entry of deletions) {
            const del = await $`${bin} ${pre} env:delete --environment ${environment} --variable-name ${entry.name} --non-interactive`
              .cwd(appDir).nothrow().quiet();
            if (del.exitCode === 0) totals.DELETE += 1;
            else { console.error(`     ✗ failed to delete ${entry.name}`); exitCode = 1; }
          }
        }
      }
    }
    console.log();
  }

  console.log("──────────────────────────────────────────────");
  console.log(
    `added ${totals.ADD} · updated ${totals.UPDATE} · unchanged ${totals.UNCHANGED} · deleted ${totals.DELETE}`,
  );
  if (!opts.prune && !opts.dryRun) {
    console.log("Orphans left in place. Re-run with --prune to mirror the file exactly.");
  }
  console.log(`Verify:  (cd ${opts.app} && ${eas.join(" ")} env:list --environment production)`);
  return exitCode;
}

process.exit(await main());
