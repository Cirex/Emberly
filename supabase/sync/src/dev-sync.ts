/**
 * Dev CLI for exercising the sync scripts from the terminal while working on
 * them. Runs any subset (or all) of the sync entrypoints against the local
 * `.env`, continues past failures, and prints a pass/fail/skip summary.
 *
 * By default every script runs FULL (no injected cap) — the same as invoking
 * the raw `run-*.ts` entrypoint. Use `--limit N` to bound the deep scrapes
 * (unit-details / lease-details) for a quick smoke test.
 *
 *   bun run sync:dev                     # list scripts + usage
 *   bun run sync:dev all                 # run every script, full
 *   bun run sync:dev units lease-details # run just these, full
 *   bun run sync:dev reports             # run a named group
 *   bun run sync:dev unit-details --limit 20   # bound the deep scrape
 *
 * A script whose required env vars are absent from `.env` is SKIPPED (not
 * failed), so the ResMan scripts still smoke-test cleanly without MLGW creds.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

interface Script {
  name: string;
  file: string;
  group: "reports" | "deep" | "mlgw";
  /** Env var this script reads to bound its work (deep scrapes only). Runs full unless `--limit N`. */
  limitEnv?: string;
  /** Env vars that MUST be present in the environment, else the script is skipped. */
  requires: string[];
  blurb: string;
}

const BASE_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESMAN_PROPERTY_ID"];

/** Env vars that satisfy a requirement under an alternate (legacy) name. */
const ENV_ALIASES: Record<string, readonly string[]> = {
  SUPABASE_URL: ["NEXT_PUBLIC_SUPABASE_URL"],
};
const RESMAN_CREDS = ["RESMAN_SYNC_USERNAME", "RESMAN_SYNC_PASSWORD"];
const MLGW_CREDS = ["MLGW_SYNC_USERNAME", "MLGW_SYNC_PASSWORD"];

const SCRIPTS: Script[] = [
  { name: "units", file: "src/run-units.ts", group: "reports", requires: [...BASE_ENV, ...RESMAN_CREDS], blurb: "unit roster (resman_units)" },
  { name: "available-units", file: "src/run-available-units.ts", group: "reports", requires: [...BASE_ENV, ...RESMAN_CREDS], blurb: "available-units report" },
  { name: "unit-info", file: "src/run-unit-info.ts", group: "reports", requires: [...BASE_ENV, ...RESMAN_CREDS], blurb: "unit-info report enrichment" },
  { name: "delinquency", file: "src/run-delinquency.ts", group: "reports", requires: [...BASE_ENV, ...RESMAN_CREDS], blurb: "delinquency report" },
  { name: "work-orders", file: "src/run-work-orders.ts", group: "reports", requires: [...BASE_ENV, ...RESMAN_CREDS], blurb: "work orders report" },
  { name: "unit-details", file: "src/run-unit-details.ts", group: "deep", limitEnv: "RESMAN_UNIT_LIMIT", requires: [...BASE_ENV, ...RESMAN_CREDS], blurb: "deep per-unit scrape (all units; --limit N to bound)" },
  { name: "lease-details", file: "src/run-lease-details.ts", group: "deep", limitEnv: "RESMAN_LEASE_LIMIT", requires: [...BASE_ENV, ...RESMAN_CREDS], blurb: "deep per-lease scrape: ledger+residents+tabs (all; --limit N to bound)" },
  { name: "mlgw-bills", file: "src/run-mlgw-bills.ts", group: "mlgw", requires: [...BASE_ENV, ...MLGW_CREDS], blurb: "MLGW utility bills" },
  { name: "mlgw-payments", file: "src/run-mlgw-payments.ts", group: "mlgw", requires: [...BASE_ENV, ...MLGW_CREDS], blurb: "MLGW payments" },
];

const GROUPS = ["reports", "deep", "mlgw"] as const;

function usage(): void {
  console.log("Sync dev runner — bun run sync:dev [targets…] [--limit N]\n");
  console.log("Targets: 'all', a group name, or one/more script names.\n");
  for (const g of GROUPS) {
    console.log(`  ${g}:`);
    for (const s of SCRIPTS.filter((x) => x.group === g)) {
      console.log(`    ${s.name.padEnd(16)} ${s.blurb}`);
    }
  }
  console.log("\nEverything runs FULL by default. Flags:");
  console.log("  --limit N     bound the deep scrapes (unit-details / lease-details) to N items");
  console.log("  --conc N      set ResMan request concurrency (default 6; the design's safe ceiling)");
  console.log("\nExamples:");
  console.log("  bun run sync:dev all");
  console.log("  bun run sync:dev reports");
  console.log("  bun run sync:dev unit-details --limit 20        # quick bounded smoke test");
  console.log("  bun run sync:dev unit-details --limit 40 --conc 12   # faster, more concurrent");
}

function missingEnv(required: string[], env: Record<string, string | undefined>): string[] {
  const present = (k: string) => Boolean(env[k] && env[k]!.trim().length > 0);
  return required.filter((k) => !present(k) && !(ENV_ALIASES[k] ?? []).some(present));
}

/** Load .env into a plain object so we can pre-check required vars per script. */
function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(".env", "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch {
    // no .env — everything will be reported as missing env
  }
  return out;
}

interface Outcome {
  name: string;
  status: "ok" | "fail" | "skip";
  ms: number;
  detail: string;
}

function runScript(s: Script, overrideEnv: Record<string, string>): Promise<Outcome> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bun", ["--env-file=.env", "run", s.file], {
      env: { ...process.env, ...overrideEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Tee child output live while capturing it, so we can extract "complete:".
    let captured = "";
    child.stdout.on("data", (chunk: Buffer) => { captured += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { process.stderr.write(chunk); });

    child.on("close", (code) => {
      const ms = Date.now() - start;
      const completeLine = captured.split("\n").reverse().find((l) => l.includes("complete:"));
      const detail = completeLine ? completeLine.slice(completeLine.indexOf("complete:") + 9).trim() : "";
      resolve({ name: s.name, status: code === 0 ? "ok" : "fail", ms, detail });
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }

  const limitIdx = argv.indexOf("--limit");
  const limitOverride = limitIdx >= 0 ? argv[limitIdx + 1] : undefined;
  const concIdx = argv.indexOf("--conc");
  const concOverride = concIdx >= 0 ? argv[concIdx + 1] : undefined;
  const targets = argv.filter(
    (a) => !a.startsWith("--") && a !== limitOverride && a !== concOverride,
  );

  // Resolve targets → ordered, de-duplicated script list.
  const selected: Script[] = [];
  const add = (s: Script) => { if (!selected.includes(s)) selected.push(s); };
  for (const t of targets) {
    if (t === "all") SCRIPTS.forEach(add);
    else if ((GROUPS as readonly string[]).includes(t)) SCRIPTS.filter((s) => s.group === t).forEach(add);
    else {
      const s = SCRIPTS.find((x) => x.name === t);
      if (s) add(s);
      else { console.error(`Unknown target: ${t}\n`); usage(); process.exit(2); }
    }
  }

  const dotenv = loadDotEnv();
  const env = { ...process.env, ...dotenv };
  const results: Outcome[] = [];

  for (const s of selected) {
    const miss = missingEnv(s.requires, env);
    if (miss.length > 0) {
      console.log(`\n=== ${s.name} — SKIPPED (missing env: ${miss.join(", ")}) ===`);
      results.push({ name: s.name, status: "skip", ms: 0, detail: `missing ${miss.join(",")}` });
      continue;
    }
    const override: Record<string, string> = {};
    if (s.limitEnv && limitOverride) override[s.limitEnv] = limitOverride;
    if (concOverride) override["RESMAN_CONNECTIONS_PER_HOST"] = concOverride;
    const parts = [
      s.limitEnv ? (limitOverride ? `limit=${limitOverride}` : "full") : "whole-property",
    ];
    if (concOverride) parts.push(`conc=${concOverride}`);
    console.log(`\n=== ${s.name} (${parts.join(", ")}) ===`);
    results.push(await runScript(s, override));
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("SYNC DEV SUMMARY");
  console.log("=".repeat(60));
  const icon = { ok: "✓", fail: "✗", skip: "–" } as const;
  for (const r of results) {
    const secs = r.ms > 0 ? `${(r.ms / 1000).toFixed(1)}s` : "";
    console.log(`  ${icon[r.status]} ${r.name.padEnd(16)} ${secs.padStart(7)}  ${r.detail}`);
  }
  const failed = results.filter((r) => r.status === "fail").length;
  const ok = results.filter((r) => r.status === "ok").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  console.log("-".repeat(60));
  console.log(`  ${ok} ok · ${failed} failed · ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("dev-sync failed:", e); process.exit(1); });
