#!/usr/bin/env bun
/**
 * Compose the per-app env files from layered sources at the repo root.
 *
 * Usage:
 *   bun run env:build [options]
 *
 *   --check      compose and DIFF against what is on disk; write nothing
 *   --examples   refresh the single documented .env.example at the repo root
 *   --app <name> restrict to one app
 *   --root <dir> operate on another checkout (defaults to this repo)
 *
 * LAYERING (later wins):
 *
 *   .env.mobile             the three Expo apps only
 *   .env.<app>              that app only
 *   .env.<app>.local        dev-only, emitted ALONE as the dev file
 *
 * produces
 *
 *   apps/security/.env.production   = .env.mobile + .env.security
 *   apps/security/.env.local        = .env.security.local
 *   apps/web/.env.production        = .env.web
 *   supabase/sync/.env              = .env.sync
 *
 * THERE IS NO UNIVERSAL LAYER. Measured against the real files, every variable
 * that genuinely repeats does so across the three Expo apps and nowhere else —
 * web's SENTRY_ORG / SENTRY_AUTH_TOKEN are empty and the worker has neither. A
 * root `.env` applied to everything would push EXPO_PUBLIC_* into the Next.js
 * app and the sync worker, which `--check` caught on the first run.
 *
 * THE DEV FILE IS NOT A RECOMPOSITION. apps/security/.env.local holds exactly
 * one variable; Expo and Next load `.env.local` IN ADDITION to the rest, so it
 * is an overlay, not a full environment. It is emitted from its own layer alone.
 *
 * WHY LAYER AT ALL. The same value was written into as many as four files —
 * SENTRY_AUTH_TOKEN lived in all three mobile apps and web — so rotating one
 * secret meant four edits and there was no way to tell whether they agreed.
 * Only ~6 variables are genuinely shared; the other 39 belong to exactly one
 * app and stay in that app's file.
 *
 * WHY SEPARATE FILES rather than one file with APP__ prefixes: four real web
 * variables already begin with an app name (RESIDENT_SESSION_SECRET,
 * RESIDENT_ENTRY_TOKEN_SECRET, RESIDENT_ACCESS_MAX_AGE_MS,
 * RESIDENT_ALLOWED_PORTAL_STATUSES). Under `APP_VAR` parsing those route to the
 * resident app and vanish from web, silently breaking resident session auth.
 * A separate file per app has no such ambiguity.
 *
 * VALUES ARE NEVER PRINTED. --check reports variable names and a verdict only.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { parseEnvFile, type EnvMap } from "./lib/env-file";

interface AppTarget {
  /** Directory holding the generated files. */
  dir: string;
  /** Group layers stacked before this app's own file, e.g. ["mobile"]. */
  groups?: string[];
  /** Generated file for the deployed environment. */
  production: string;
  /** Generated file for local development, when the app has one. */
  dev?: string;
}

const APPS: Record<string, AppTarget> = {
  web: {
    dir: "apps/web",
    production: ".env.production",
    dev: ".env.local",
  },
  resident: {
    dir: "apps/resident",
    groups: ["mobile"],
    production: ".env.production",
  },
  security: {
    dir: "apps/security",
    groups: ["mobile"],
    production: ".env.production",
    dev: ".env.local",
  },
  maintenance: {
    dir: "apps/maintenance",
    groups: ["mobile"],
    production: ".env.production",
    dev: ".env.local",
  },
  manager: {
    dir: "apps/manager",
    groups: ["mobile"],
    production: ".env.production",
    dev: ".env.local",
  },
  // The worker reads `.env`, not `.env.production` — its own .env.example says
  // to copy to `.env`, and there is no production variant in that package.
  sync: {
    dir: "supabase/sync",
    production: ".env",
  },
};

interface Options { check: boolean; examples: boolean; only?: string; root?: string }

function parseArgs(argv: string[]): Options {
  const opts: Options = { check: false, examples: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--check":    opts.check = true; break;
      case "--examples": opts.examples = true; break;
      case "--app": {
        const v = argv[i + 1];
        if (!v || !APPS[v]) {
          console.error(`✗ --app needs one of: ${Object.keys(APPS).join(" | ")}`);
          process.exit(2);
        }
        opts.only = v; i += 1; break;
      }
      case "--root": {
        const v = argv[i + 1];
        if (!v) { console.error("✗ --root needs a directory"); process.exit(2); }
        opts.root = v; i += 1; break;
      }
      default:
        console.error(`✗ unknown option: ${argv[i]}`);
        console.error("usage: bun run env:build [--check] [--examples] [--app <name>] [--root <dir>]");
        process.exit(2);
    }
  }
  return opts;
}

/** A source line kept verbatim, so hand-written documentation survives. */
interface SourceLine { kind: "comment" | "blank" | "var"; raw: string; key?: string }

function readSource(file: string, text: string): SourceLine[] {
  return text.split("\n").map((raw): SourceLine => {
    const line = raw.trimEnd();
    if (line.length === 0) return { kind: "blank", raw: "" };
    if (line.startsWith("#")) return { kind: "comment", raw: line };
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    return m ? { kind: "var", raw: line, key: m[1] } : { kind: "comment", raw: line };
  });
}

async function loadLayer(repoRoot: string, name: string): Promise<SourceLine[] | null> {
  const file = path.join(repoRoot, name);
  if (!existsSync(file)) return null;
  return readSource(name, await Bun.file(file).text());
}

/**
 * Compose the layers into output lines. Later layers override earlier ones in
 * place (so a shared variable an app overrides keeps the shared file's comment
 * position), and anything new is appended under its own layer's heading.
 */
function compose(layers: { name: string; lines: SourceLine[] }[]): { lines: string[]; vars: EnvMap } {
  const finalValue = new Map<string, string>();
  const owner = new Map<string, string>();
  for (const layer of layers) {
    for (const line of layer.lines) {
      if (line.kind !== "var" || !line.key) continue;
      finalValue.set(line.key, line.raw.slice(line.raw.indexOf("=") + 1));
      owner.set(line.key, layer.name);
    }
  }

  const out: string[] = [];
  const emitted = new Set<string>();
  for (const layer of layers) {
    const ownHere = layer.lines.some((l) => l.kind === "var" && l.key && owner.get(l.key) === layer.name && !emitted.has(l.key));
    const laterOverride = layer.lines.some((l) => l.kind === "var" && l.key && !emitted.has(l.key));
    if (!ownHere && !laterOverride) continue;
    if (out.length > 0) out.push("");
    out.push(`# ─── from ${layer.name} ───`);
    for (const line of layer.lines) {
      if (line.kind === "var" && line.key) {
        if (emitted.has(line.key)) continue;
        emitted.add(line.key);
        out.push(`${line.key}=${finalValue.get(line.key)}`);
      } else if (line.raw.startsWith("# ─── from ")) {
        continue; // never re-emit a generated heading
      } else {
        out.push(line.raw);
      }
    }
  }
  // Trim leading/trailing blank runs so regeneration is stable.
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return { lines: out, vars: new Map(finalValue) };
}

const HEADER = [
  "# GENERATED by `bun run env:build` — do not edit.",
  "# Edit the layered sources at the repo root instead: .env, .env.<app>,",
  "# .env.<app>.local. Run `bun run env:build --check` to see drift.",
  "",
];

function render(lines: string[]): string {
  return `${[...HEADER, ...lines].join("\n")}\n`;
}

/**
 * Harvest the comment block that documents `key` from a committed .example.
 *
 * The real env files carry values; the .example files carry the prose (which
 * password is the rotated one, that Langbly is optional, why a var is empty).
 * That prose is the whole point of a template, so it is read from there rather
 * than regenerated as bare names.
 */
function docsFromMarkdown(key: string, md: string): string[] {
  // Rows look like: | `VAR_A`, `VAR_B` | **secret** | Notes… |
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4) continue;
    const names = [...cells[1].matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]);
    if (!names.includes(key)) continue;
    const secret = /secret/i.test(cells[2]);
    const notes = cells[3].replace(/\s+/g, " ").trim();
    if (!notes) continue;
    return [`# ${notes}${secret ? "  (SECRET)" : ""}`];
  }
  return [];
}

/**
 * Prose for a variable, from docs/Environment-Variables.md.
 *
 * That table is the single committed home for per-variable documentation. It
 * used to be split with the per-app .env*.example files, which meant deleting
 * those would silently strip the generated template — so their prose was moved
 * into the doc before they were removed.
 */
function docsFor(key: string, markdown = ""): string[] {
  return docsFromMarkdown(key, markdown);
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = opts.root ? path.resolve(opts.root) : path.resolve(import.meta.dir, "..");


  const names = opts.only ? [opts.only] : Object.keys(APPS);
  let drift = 0;
  let wrote = 0;
  const referenceDocPath = path.join(repoRoot, "docs", "Environment-Variables.md");
  const referenceDoc = existsSync(referenceDocPath) ? await Bun.file(referenceDocPath).text() : "";

  for (const name of names) {
    const app = APPS[name]!;
    const appLayer = await loadLayer(repoRoot, `.env.${name}`);
    const devLayer = await loadLayer(repoRoot, `.env.${name}.local`);

    const stack: { name: string; lines: SourceLine[] }[] = [];
    for (const group of app.groups ?? []) {
      const g = await loadLayer(repoRoot, `.env.${group}`);
      if (g) stack.push({ name: `.env.${group}`, lines: g });
    }
    if (appLayer) stack.push({ name: `.env.${name}`, lines: appLayer });

    const outputs: { file: string; body: string; label: string }[] = [];
    // A group layer alone must not materialise config for an app that has none
    // of its own — manager has only a .env.example today, and generating a full
    // production file for it would invent configuration nobody wrote.
    if (!appLayer) { console.log(`── ${name} ───  no .env.${name}, skipped`); continue; }
    const prod = compose(stack);
    outputs.push({ file: path.join(app.dir, app.production), body: render(prod.lines), label: "production" });

    let dev: ReturnType<typeof compose> | null = null;
    if (app.dev) {
      // The dev file is an OVERLAY, emitted from its own layer alone — see the
      // header. Composing the full stack into it would write the entire
      // production environment into a file that holds one variable today.
      dev = devLayer ? compose([{ name: `.env.${name}.local`, lines: devLayer }]) : null;
      if (dev) outputs.push({ file: path.join(app.dir, app.dev), body: render(dev.lines), label: "dev" });
    }


    console.log(`── ${name} ───────────────────────────────`);
    for (const out of outputs) {
      const abs = path.join(repoRoot, out.file);
      const current = existsSync(abs) ? await Bun.file(abs).text() : null;

      if (opts.check) {
        // Compare by VARIABLE SET, not bytes: layering reorders lines and adds
        // headings, so byte equality would fail on a correct migration. What
        // matters is that no name appears, disappears, or changes value.
        const want = parseEnvFile(out.body);
        const have = current === null ? new Map<string, string>() : parseEnvFile(current);
        const added = [...want.keys()].filter((k) => !have.has(k));
        const removed = [...have.keys()].filter((k) => !want.has(k));
        const changed = [...want.keys()].filter((k) => have.has(k) && have.get(k) !== want.get(k));
        if (added.length === 0 && removed.length === 0 && changed.length === 0) {
          console.log(`  ✓ ${out.file}  (${want.size} vars, identical)`);
        } else {
          drift += 1;
          console.log(`  ✗ ${out.file}`);
          if (added.length)   console.log(`      would ADD:     ${added.join(", ")}`);
          if (removed.length) console.log(`      would REMOVE:  ${removed.join(", ")}`);
          if (changed.length) console.log(`      would CHANGE:  ${changed.join(", ")}`);
        }
        continue;
      }

      if (current === out.body) {
        console.log(`  · ${out.file}  unchanged`);
      } else {
        await Bun.write(abs, out.body);
        wrote += 1;
        console.log(`  ✓ ${out.file}  written`);
      }
    }
    console.log();
  }

  if (opts.examples && !opts.only) {
    // One committed template for the whole repo, sectioned by layer, values
    // blanked, prose lifted from the per-app .example files it replaces.
    const sections: string[] = [];
    const layerFiles = [
      ".env.mobile",
      ...Object.keys(APPS).map((n) => `.env.${n}`),
      ...Object.keys(APPS).map((n) => `.env.${n}.local`),
    ];
    let documented = 0, total = 0;
    for (const layerFile of layerFiles) {
      const layer = await loadLayer(repoRoot, layerFile);
      if (!layer) continue;
      const vars = layer.filter((l) => l.kind === "var" && l.key);
      if (vars.length === 0) continue;
      sections.push("", `# ${"═".repeat(74)}`, `# ${layerFile}`, `# ${"═".repeat(74)}`);
      for (const line of vars) {
        const docs = docsFor(line.key!, referenceDoc);
        if (docs.length) documented += 1;
        total += 1;
        sections.push("", ...docs, `${line.key}=`);
      }
    }
    const body = [
      "# Emberly — every environment variable, in one place.",
      "#",
      "# GENERATED by `bun run env:build --examples`. Values are blanked; the",
      "# prose is carried over from the per-app templates this replaces.",
      "#",
      "# HOW THE REAL FILES WORK. You do not edit apps/*/.env* — those are",
      "# generated. Edit these gitignored sources at the repo root and run",
      "# `bun run env:build`:",
      "#",
      "#   .env.mobile          shared by resident / security / maintenance",
      "#   .env.<app>           one app only",
      "#   .env.<app>.local     dev-only overlay, emitted as that app's .env.local",
      "#",
      "# `bun run env:build --check` reports drift without writing anything.",
      "#",
      "# There is deliberately no universal layer: measured against the real",
      "# files, every variable that repeats does so across the three Expo apps",
      "# and nowhere else.",
      ...sections,
    ].join("\n") + "\n";
    const target = path.join(repoRoot, ".env.example");
    const current = existsSync(target) ? await Bun.file(target).text() : null;
    if (opts.check) {
      console.log(current === body ? "  ✓ .env.example  up to date" : "  ✗ .env.example  out of date");
      if (current !== body) drift += 1;
    } else if (current !== body) {
      await Bun.write(target, body);
      wrote += 1;
      console.log(`  ✓ .env.example  written (${total} variables, ${documented} with documentation)`);
    }
  }

  if (opts.check) {
    console.log(drift === 0
      ? "✓ every generated file matches its layered sources."
      : `✗ ${drift} file(s) differ — run without --check to rewrite them.`);
    return drift === 0 ? 0 : 1;
  }
  console.log(`${wrote} file(s) written.`);
  return 0;
}

process.exit(await main());
