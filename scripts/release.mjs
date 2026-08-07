#!/usr/bin/env bun
/**
 * One front door for shipping any app in this repo.
 *
 * Usage:
 *   bun scripts/release.ts <app> [options]
 *
 *   <app>            web | maintenance | security | manager | resident
 *   --dry-run        run every check, then stop before shipping anything
 *   --submit         mobile only: submit to TestFlight after a successful build
 *   --profile <name> mobile only: EAS build profile (default: production)
 *   --preview        web only: deploy to a preview URL instead of production
 *   --allow-dirty    mobile only: build despite uncommitted changes
 *   --skip-env       mobile only: don't sync .env.production into EAS first
 *   --yes, -y        don't prompt before the irreversible step
 *
 * Examples:
 *   bun scripts/release.ts security --dry-run   # what would ship, and from what
 *   bun scripts/release.ts security --submit    # build → TestFlight
 *   bun scripts/release.ts web --preview        # preview deploy
 *   bun scripts/release.ts web                  # production deploy (prompts)
 *
 * This does not bump versions — that is `bun run version`, deliberately a
 * separate step so a release is always shipping a version somebody chose.
 *
 * Ported from release.sh. Behaviour is unchanged, including the two guards that
 * matter most: the version-drift gate refuses before anything is built, and a
 * production web deploy refuses to run unattended without --yes.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import path from "node:path";

const APPS = ["web", "maintenance", "security", "manager", "resident"];

function usage() {
  console.error("usage: bun scripts/release.ts <app> [--dry-run] [--submit] [--profile <name>]");
  console.error("                              [--preview] [--allow-dirty] [--skip-env] [--yes]");
  console.error(`  <app>  ${APPS.join(" | ")}`);
  process.exit(2);
}

function parseArgs(argv) {
  const [app, ...rest] = argv;
  if (!app) usage();
  if (!APPS.includes(app)) {
    console.error(`✗ unknown app: ${app} (${APPS.join(" | ")})`);
    process.exit(2);
  }
  const opts = {
    app: app, dryRun: false, assumeYes: false, webTarget: "prod", passthru: [],
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case "--dry-run": opts.dryRun = true; opts.passthru.push(arg); break;
      case "--yes": case "-y": opts.assumeYes = true; opts.passthru.push(arg); break;
      case "--preview": opts.webTarget = "preview"; break;
      case "--profile": {
        const v = rest[i + 1];
        if (!v) { console.error("✗ --profile needs a value"); process.exit(2); }
        opts.passthru.push(arg, v); i += 1; break;
      }
      case "--submit": case "--allow-dirty": case "--skip-env":
        opts.passthru.push(arg); break;
      default: console.error(`✗ unknown option: ${arg}`); process.exit(2);
    }
  }
  return opts;
}

/**
 * Version gate.
 *
 * A drifted app has no single answer to "what version is this", and the four
 * places it lives do not all reach the binary. Shipping one is how a build ends
 * up labelled with a version that never existed — so this refuses before
 * anything is built rather than after.
 */
async function resolveVersion(repoRoot, app) {
  const versionScript = path.join(repoRoot, "scripts", "version.mjs");
  const report = (await $`bun ${versionScript}`.cwd(repoRoot).nothrow().quiet()).stdout.toString();
  const line = report.split("\n").find((l) => new RegExp(`^${app}\\s`).test(l)) ?? "";
  if (line.includes("DRIFT")) {
    console.error(`✗ ${app}'s version disagrees with itself — refusing to ship an ambiguous build.`);
    console.error();
    console.error(report);
    process.exit(1);
  }
  return line.trim().split(/\s+/)[1] || "?";
}

async function confirm(question, assumeYes) {
  if (assumeYes) return;
  if (!process.stdin.isTTY) {
    console.error("✗ not a terminal and --yes not given — refusing to ship unattended");
    process.exit(1);
  }
  process.stdout.write(`${question} [y/N] `);
  for await (const line of console) {
    if (/^(y|yes)$/i.test(line.trim())) return;
    break;
  }
  console.log("aborted.");
  process.exit(1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dir, "..");
  const version = await resolveVersion(repoRoot, opts.app);

  // ── Mobile — delegate to eas-release.ts, which owns the EAS preflight ──────
  if (opts.app !== "web") {
    const appDir = `apps/${opts.app}`;
    if (!existsSync(path.join(repoRoot, appDir, "eas.json"))) {
      console.error(`✗ ${appDir} has no eas.json, so it cannot be built by EAS.`);
      console.error(`  Run 'eas init' inside ${appDir} and add a production build profile.`);
      return 1;
    }
    console.log(`━━ ${opts.app} v${version} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    const easRelease = path.join(import.meta.dir, "eas-release.ts");
    const run = await $`bun ${easRelease} ${appDir} ${opts.passthru}`.cwd(repoRoot).nothrow();
    return run.exitCode;
  }

  // ── Web — Vercel. `deploy:*` already runs verify (test + typecheck + build) ─
  console.log(`━━ web v${version} → ${opts.webTarget} ━━━━━━━━━━━━━━━━━━━`);

  const branch = (await $`git branch --show-current`.cwd(repoRoot).nothrow().quiet())
    .stdout.toString().trim() || "?";
  const dirty = (await $`git status --porcelain -- apps/web packages`.cwd(repoRoot).nothrow().quiet())
    .stdout.toString().trim();
  if (dirty) {
    console.log("  ! uncommitted changes in apps/web or packages:");
    for (const line of dirty.split("\n")) console.log(`      ${line}`);
    console.log("      (Vercel deploys the WORKING TREE, so these WILL ship — unlike EAS, which uses git.)");
  } else {
    console.log("  ✓ git          clean across apps/web packages");
  }

  let ahead = 0;
  if ((await $`git rev-parse --abbrev-ref @{upstream}`.cwd(repoRoot).nothrow().quiet()).exitCode === 0) {
    ahead = Number(
      (await $`git rev-list --count @{upstream}..HEAD`.cwd(repoRoot).nothrow().quiet())
        .stdout.toString().trim() || "0",
    );
  }
  console.log(ahead > 0
    ? `  ! branch       ${branch} is ${ahead} commit(s) ahead of upstream`
    : `  ✓ branch       ${branch}, in sync with upstream`);

  console.log(existsSync(path.join(repoRoot, "apps/web/.env.production"))
    ? "  ✓ env          apps/web/.env.production present (Vercel's stored values still win at runtime)"
    : "  ! env          apps/web/.env.production absent — Vercel will use its stored values");

  console.log();
  if (opts.dryRun) {
    console.log("DRY RUN — preflight complete, stopping before deploy.");
    return 0;
  }

  let script = "deploy:preview";
  if (opts.webTarget === "prod") {
    await confirm(`Deploy web v${version} to PRODUCTION?`, opts.assumeYes);
    script = "deploy:prod";
  }

  console.log("━━ deploying ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const deploy = await $`bun run --filter @emberly/web ${script}`.cwd(repoRoot).nothrow();
  if (deploy.exitCode !== 0) return deploy.exitCode;

  console.log();
  console.log(`✓ done — web v${version} (${opts.webTarget})`);
  return 0;
}

process.exit(await main());
