#!/usr/bin/env bun
/**
 * Get one app ready to work on, then launch its dev server.
 *
 * Usage:
 *   bun run start <app> [options] [-- <extra args for the dev server>]
 *
 *   <app>          web | resident | security | maintenance | manager
 *   --no-prepare   skip the install/build checks and launch straight away
 *   --check        run the preparation checks and stop (no dev server)
 *
 * Examples:
 *   bun run start security             # prepare, then `expo start`
 *   bun run start web                  # prepare, then `next dev`
 *   bun run start security -- --clear  # …and clear Metro's cache
 *
 * WHY THIS IS MORE THAN `expo start`. `@emberly/core` is consumed through its
 * COMPILED output — `main: dist/index.js` — and `dist/` is gitignored. Nothing
 * builds it on install, so on a fresh clone (or after a `dist` wipe) every app
 * fails with "Cannot find module '@emberly/core'" the moment it imports one.
 * That is a confusing first-run failure with an unobvious fix, and it is the
 * main thing this script exists to prevent.
 *
 * `@emberly/ui` deliberately needs no build — `main: src/index.ts`, consumed as
 * source — so it is not in the build step even though three apps depend on it.
 */
import { existsSync } from "node:fs";
import path from "node:path";

interface AppSpec {
  /** Workspace package name, for `bun run --filter`. */
  pkg: string;
  /** Script in that package's package.json that starts the dev server. */
  devScript: string;
  /** How to describe what launching does, in the log line. */
  what: string;
}

const APPS: Record<string, AppSpec> = {
  web:         { pkg: "@emberly/web",         devScript: "dev",   what: "next dev" },
  resident:    { pkg: "@emberly/resident",    devScript: "start", what: "expo start" },
  security:    { pkg: "@emberly/security",    devScript: "start", what: "expo start" },
  maintenance: { pkg: "@emberly/maintenance", devScript: "start", what: "expo start" },
  manager:     { pkg: "@emberly/manager",     devScript: "start", what: "expo start" },
};

/** Workspace packages that must be COMPILED before an app can import them. */
const BUILT_PACKAGES = [
  { pkg: "@emberly/core", dir: "packages/core", output: "packages/core/dist" },
];

interface Options {
  app: string;
  prepare: boolean;
  checkOnly: boolean;
  passthru: string[];
}

function usage(): never {
  console.error("usage: bun run start <app> [--no-prepare] [--check] [-- <dev server args>]");
  console.error(`  <app>  ${Object.keys(APPS).join(" | ")}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const [app, ...rest] = argv;
  if (!app) usage();
  if (!APPS[app]) {
    console.error(`✗ unknown app: ${app} (${Object.keys(APPS).join(" | ")})`);
    process.exit(2);
  }
  const opts: Options = { app, prepare: true, checkOnly: false, passthru: [] };
  const sep = rest.indexOf("--");
  const own = sep === -1 ? rest : rest.slice(0, sep);
  if (sep !== -1) opts.passthru = rest.slice(sep + 1);
  for (const arg of own) {
    switch (arg) {
      case "--no-prepare": opts.prepare = false; break;
      case "--check":      opts.checkOnly = true; break;
      default: console.error(`✗ unknown option: ${arg}`); process.exit(2);
    }
  }
  return opts;
}

/** Run a command with inherited stdio, so interactive output works. */
async function run(cmd: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dir, "..");
  const spec = APPS[opts.app]!;
  const appDir = path.join(repoRoot, "apps", opts.app);

  if (opts.prepare) {
    console.log(`━━ preparing ${opts.app} ━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // 1. Dependencies. A missing root node_modules means nothing will resolve.
    if (!existsSync(path.join(repoRoot, "node_modules"))) {
      console.log("  · deps         node_modules missing — installing");
      const code = await run(["bun", "install"], repoRoot);
      if (code !== 0) { console.error("✗ bun install failed"); return code; }
    } else {
      console.log("  ✓ deps         node_modules present");
    }

    // 2. Compiled workspace packages. This is the one that actually bites.
    for (const target of BUILT_PACKAGES) {
      if (existsSync(path.join(repoRoot, target.output))) {
        console.log(`  ✓ ${target.pkg.padEnd(12)} built`);
        continue;
      }
      console.log(`  · ${target.pkg.padEnd(12)} not built — building (imports fail without it)`);
      const code = await run(["bun", "run", "--filter", target.pkg, "build"], repoRoot);
      if (code !== 0) { console.error(`✗ building ${target.pkg} failed`); return code; }
    }

    // 3. Local env. Absent is legal — every app boots with observability inert —
    //    so this informs rather than blocks.
    const envLocal = path.join(appDir, ".env.local");
    const example = path.join(appDir, ".env.example");
    if (existsSync(envLocal)) {
      console.log("  ✓ env          .env.local present");
    } else if (existsSync(example)) {
      console.log(`  ! env          no .env.local — the app will run with defaults`);
      console.log(`                 cp apps/${opts.app}/.env.example apps/${opts.app}/.env.local`);
    }

    console.log();
    if (opts.checkOnly) {
      console.log("--check — prepared, not launching.");
      return 0;
    }
  }

  console.log(`━━ ${opts.app} → ${spec.what} ━━━━━━━━━━━━━━━━━━━━━━`);
  const cmd = ["bun", "run", "--filter", spec.pkg, spec.devScript, ...opts.passthru];
  return run(cmd, repoRoot);
}

process.exit(await main());
