#!/usr/bin/env bun
/**
 * Build (and optionally submit) one mobile app through EAS, with the preflight
 * checks that are easy to forget and expensive to miss.
 *
 * Usage:
 *   bun scripts/eas-release.mjs <app-dir> [options]
 *
 *   --profile <name>   EAS build profile (default: production)
 *   --submit           run `eas submit` after a successful build
 *   --local            build on THIS machine instead of EAS's queue (no build
 *                      credits spent; needs Xcode + fastlane). The .ipa is
 *                      written into the app dir, and --submit uploads that file
 *                      rather than asking EAS for its latest hosted build.
 *   --skip-env         don't sync .env.production into EAS first
 *   --allow-dirty      build even with uncommitted changes (see below)
 *   --dry-run          run every check, then stop before building
 *   --yes, -y          non-interactive; assume yes at prompts
 *
 * Examples:
 *   bun scripts/eas-release.mjs apps/security --dry-run   # preflight only
 *   bun scripts/eas-release.mjs apps/security --submit    # build → TestFlight
 *   bun scripts/eas-release.mjs apps/security --local --submit  # build here → TestFlight
 *
 * WHY THE DIRTY-TREE CHECK MATTERS: EAS builds from your COMMITTED git state,
 * not your working tree. Uncommitted changes are silently absent from the
 * binary. A native change (a new pod, an entitlement) left uncommitted produces
 * a build that looks fine and is missing the feature.
 *
 * Ported from eas-release.sh. Behaviour is unchanged. The app.json/eas.json
 * probes were three `node -e` subprocesses interpolating a path into a string
 * of JS — they are now plain imports, which removes both the process spawns and
 * the injection hazard of a path containing a quote.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import path from "node:path";

const USAGE = "usage: bun scripts/eas-release.mjs <app-dir> [--profile production] [--submit] [--local] [--dry-run]";

function parseArgs(argv) {
  const [app, ...rest] = argv;
  if (!app || app.startsWith("--")) { console.error(USAGE); process.exit(2); }
  const opts = {
    app: app.replace(/\/+$/, ""),
    profile: "production",
    submit: false, skipEnv: false, allowDirty: false, dryRun: false, assumeYes: false,
    local: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    switch (rest[i]) {
      case "--profile": {
        const v = rest[i + 1];
        if (!v) { console.error("✗ --profile needs a value"); process.exit(2); }
        opts.profile = v; i += 1; break;
      }
      case "--local":   opts.local = true; break;
      case "--submit":      opts.submit = true; break;
      case "--skip-env":    opts.skipEnv = true; break;
      case "--allow-dirty": opts.allowDirty = true; break;
      case "--dry-run":     opts.dryRun = true; break;
      case "--yes": case "-y": opts.assumeYes = true; break;
      default: console.error(`✗ unknown option: ${rest[i]}`); process.exit(2);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** `expo` key if present, else the object itself — app.json has both shapes. */
async function readJson(file) {
  if (!existsSync(file)) return null;
  try { return await Bun.file(file).json(); } catch { return null; }
}

/**
 * Run a child on THIS terminal, not through a pipe.
 *
 * Bun's `$` captures the child's output and re-emits it, so the child is
 * handed a pipe and `process.stdout.isTTY` is false inside it. EAS keeps
 * animating its ora spinner anyway, and every frame it writes — sixty a
 * second through an upload that runs for minutes — arrives as fresh output
 * instead of overwriting the line before it. The submit step alone scrolled
 * hundreds of copies of "submission in progress" past.
 *
 * Inheriting stdio hands over the real TTY: the spinner overwrites itself the
 * way it does when you run `eas` by hand, progress bars work, and EAS can
 * prompt interactively (for credentials, or an ASC 2FA code) instead of
 * blocking against a pipe nobody is reading.
 *
 * Only for children whose output is meant for the user to watch. The env-diff
 * below still uses `$`.quiet(), because that one is captured and reformatted.
 */
async function runAttached(cmd, cwd) {
  const child = Bun.spawn(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  return await child.exited;
}

async function resolveEas() {
  const found = await $`command -v eas`.nothrow().quiet();
  return found.exitCode === 0 ? ["eas"] : ["bunx", "eas-cli"];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dir, "..");
  const appDir = path.resolve(repoRoot, opts.app);
  const eas = await resolveEas();

  console.log("━━ preflight ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // 1. the app is real and EAS-ready
  if (!existsSync(appDir)) fail(`no such app directory: ${opts.app}`);
  if (!existsSync(path.join(appDir, "eas.json"))) {
    fail(`${opts.app} has no eas.json — run 'eas init' in that directory and add a build profile first`);
  }

  const appJson = await readJson(path.join(appDir, "app.json"));
  const expo = appJson?.expo ?? appJson ?? {};
  const version = expo.version ?? "?";
  const bundleId = expo.ios?.bundleIdentifier ?? "";
  const linked = Boolean(expo.extra?.eas?.projectId);

  if (!bundleId) fail(`${opts.app} has no ios.bundleIdentifier in app.json`);
  if (!linked) fail(`${opts.app} is not linked to an EAS project — run 'eas init' inside ${opts.app}`);

  const easJson = await readJson(path.join(appDir, "eas.json"));
  if (!easJson?.build?.[opts.profile]) fail(`eas.json has no build profile named '${opts.profile}'`);

  console.log(`  ✓ app          ${opts.app}  v${version}  (${bundleId})`);
  console.log(`  ✓ profile      ${opts.profile}`);

  // 2. committed state — EAS builds this, not your working tree.
  //    Shared packages count: they compile into the app.
  const watchPaths = [opts.app, "packages"];
  const dirty = (await $`git status --porcelain -- ${watchPaths}`.cwd(repoRoot).nothrow().quiet())
    .stdout.toString().trim();
  if (dirty) {
    console.log("  ! uncommitted changes affecting this build:");
    for (const line of dirty.split("\n")) console.log(`      ${line}`);
    if (opts.allowDirty) {
      console.log("      --allow-dirty set: continuing. These changes will NOT be in the binary.");
    } else {
      fail("commit (or stash) the above, or pass --allow-dirty to build without them");
    }
  } else {
    console.log(`  ✓ git          clean across ${watchPaths.join(" ")}`);
  }

  const branch = (await $`git branch --show-current`.cwd(repoRoot).nothrow().quiet())
    .stdout.toString().trim() || "?";
  const upstream = await $`git rev-parse --abbrev-ref @{upstream}`.cwd(repoRoot).nothrow().quiet();
  if (upstream.exitCode !== 0) {
    console.log(`  ! branch       ${branch} has no upstream (nothing pushed)`);
  } else {
    const ahead = Number(
      (await $`git rev-list --count @{upstream}..HEAD`.cwd(repoRoot).nothrow().quiet())
        .stdout.toString().trim() || "0",
    );
    if (ahead > 0) {
      console.log(`  ! branch       ${branch} is ${ahead} commit(s) ahead of its upstream — push so the build is reproducible`);
    } else {
      console.log(`  ✓ branch       ${branch}, in sync with upstream`);
    }
  }

  // 3. environment
  const envFile = path.join(appDir, ".env.production");
  const syncScript = path.join(import.meta.dir, "eas-env-sync.mjs");
  if (opts.skipEnv) {
    console.log("  · env          skipped (--skip-env)");
  } else if (!existsSync(envFile)) {
    console.log(`  ! env          ${opts.app}/.env.production not found — EAS will build with whatever is already stored`);
  } else {
    console.log("  · env          diff against EAS:");
    const diff = await $`bun ${syncScript} ${opts.app} --environments ${opts.profile} --dry-run`
      .cwd(repoRoot).nothrow().quiet();
    const text = `${diff.stdout.toString()}${diff.stderr.toString()}`.trimEnd();
    for (const line of text.split("\n")) console.log(`      ${line}`);
  }

  console.log();
  if (opts.dryRun) {
    console.log("DRY RUN — preflight complete, stopping before build.");
    return 0;
  }

  // Push the env for real before building, so the build reads current values.
  if (!opts.skipEnv && existsSync(envFile)) {
    console.log("━━ syncing env ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    const args = [opts.app, "--environments", opts.profile, ...(opts.assumeYes ? ["--yes"] : [])];
    const syncCode = await runAttached(["bun", syncScript, ...args], repoRoot);
    if (syncCode !== 0) fail("env sync failed — not building with a half-applied environment");
    console.log();
  }

  console.log("━━ building ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const [bin, ...pre] = eas;
  // A local build writes the .ipa here instead of leaving it on EAS. The name
  // carries the version so two builds of different versions never collide in
  // the app dir, and --submit below uploads exactly this file.
  const localOutput = `build-${version}.ipa`;
  const buildArgs = ["build", "--platform", "ios", "--profile", opts.profile,
    ...(opts.local ? ["--local", "--output", localOutput] : []),
    ...(opts.assumeYes ? ["--non-interactive"] : [])];
  if (opts.local) {
    console.log("  · local       building on this machine (no EAS build credits spent)");
  }
  const buildCode = await runAttached([bin, ...pre, ...buildArgs], appDir);
  if (buildCode !== 0) return buildCode;

  if (opts.submit) {
    console.log();
    console.log("━━ submitting ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    // --latest asks EAS for its most recent HOSTED build, which a local build
    // is not — upload the artifact this run just produced instead.
    const submitArgs = ["submit", "--platform", "ios", "--profile", opts.profile,
      ...(opts.local ? ["--path", localOutput] : ["--latest"]),
      ...(opts.assumeYes ? ["--non-interactive"] : [])];
    const submitCode = await runAttached([bin, ...pre, ...submitArgs], appDir);
    if (submitCode !== 0) return submitCode;
  }

  console.log();
  console.log(`✓ done — ${opts.app} v${version} (${opts.profile})`);
  return 0;
}

process.exit(await main());
