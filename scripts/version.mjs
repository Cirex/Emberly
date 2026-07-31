#!/usr/bin/env bun
/**
 * Read and bump app versions across every place one actually lives.
 *
 *   bun run version                        # show every app, and any drift
 *   bun run version security patch         # 2.0.1 -> 2.0.2
 *   bun run version manager minor          # 1.0.0 -> 1.1.0
 *   bun run version resident major         # 1.0.0 -> 2.0.0
 *   bun run version security --set 2.1.0   # exact, for reconciling drift
 *   bun run version security patch --dry-run
 *
 * WHY THIS EXISTS RATHER THAN `npm version`: a version is not in one file.
 * An Expo app carries it in up to four, and they are NOT kept in sync by any
 * tool here:
 *
 *   package.json          version                      (workspace metadata)
 *   app.json              expo.version                 (what Expo reads)
 *   ios/<App>/Info.plist  CFBundleShortVersionString   (what SHIPS)
 *   ios/<App>.xcodeproj/project.pbxproj
 *                         MARKETING_VERSION  x2        (Debug + Release)
 *
 * The last two matter more than they look. `ios/` is COMMITTED in this repo,
 * so EAS treats these as bare projects and does not run `expo prebuild` — the
 * native values are what reaches TestFlight, and app.json is decoration at
 * that point. Bumping app.json alone would ship the old version under a new
 * number in the changelog, which is the kind of wrong nobody notices until a
 * crash report points at a build that supposedly does not exist.
 *
 * Build numbers are deliberately untouched: eas.json sets
 * `appVersionSource: "remote"` with `autoIncrement`, so EAS owns
 * CFBundleVersion. Writing it here would fight the service that already
 * manages it.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** Every workspace whose version this tool manages. */
const TARGETS = [
  { name: "web", dir: "apps/web", kind: "node" },
  { name: "maintenance", dir: "apps/maintenance", kind: "expo" },
  { name: "security", dir: "apps/security", kind: "expo" },
  { name: "manager", dir: "apps/manager", kind: "expo" },
  { name: "resident", dir: "apps/resident", kind: "expo" },
  { name: "core", dir: "packages/core", kind: "node" },
  { name: "ui", dir: "packages/ui", kind: "node" },
  { name: "sync", dir: "supabase/sync", kind: "node" },
];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function bump(version, level) {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`"${version}" is not a plain x.y.z version — use --set to fix it`);
  let [, major, minor, patch] = m.map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  if (level === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown level "${level}"`);
}

// --- the places a version lives ---------------------------------------------
//
// Each site knows how to read and write ONE file. A site that does not apply
// (a Node package has no Info.plist) simply reports null and is skipped, so
// the same code path serves web, packages and apps.

const abs = (t, rel) => path.join(ROOT, t.dir, rel);
const exists = (p) => fs.existsSync(p);

/** The Xcode project directory name, e.g. "EmberlySecurity". */
function iosProjectName(t) {
  const iosDir = abs(t, "ios");
  if (!exists(iosDir)) return null;
  const proj = fs.readdirSync(iosDir).find((f) => f.endsWith(".xcodeproj"));
  return proj ? proj.replace(/\.xcodeproj$/, "") : null;
}

function sites(t) {
  const out = [];

  out.push({
    label: "package.json",
    file: abs(t, "package.json"),
    read: (s) => JSON.parse(s).version ?? null,
    write: (s, v) => s.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${v}"`),
  });

  if (t.kind === "expo") {
    out.push({
      label: "app.json",
      file: abs(t, "app.json"),
      read: (s) => { const j = JSON.parse(s); return (j.expo ?? j).version ?? null; },
      write: (s, v) => s.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${v}"`),
    });

    const proj = iosProjectName(t);
    if (proj) {
      out.push({
        label: `ios/${proj}/Info.plist`,
        file: abs(t, `ios/${proj}/Info.plist`),
        read: (s) => s.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? null,
        write: (s, v) => s.replace(
          /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
          `$1${v}$2`,
        ),
      });
      out.push({
        label: `ios/${proj}.xcodeproj`,
        file: abs(t, `ios/${proj}.xcodeproj/project.pbxproj`),
        // Debug and Release each carry one. They must agree, so read reports a
        // disagreement rather than silently picking the first.
        read: (s) => {
          const all = [...s.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1].trim());
          if (all.length === 0) return null;
          return all.every((v) => v === all[0]) ? all[0] : `${all.join(" / ")} (disagree)`;
        },
        write: (s, v) => s.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${v};`),
      });
    }
  }

  return out.filter((s) => exists(s.file));
}

/** Current version per site, plus whether they all agree. */
function inspect(t) {
  const found = sites(t).map((s) => ({ ...s, value: s.read(fs.readFileSync(s.file, "utf8")) }));
  const values = found.map((s) => s.value).filter(Boolean);
  const distinct = [...new Set(values)];
  return { target: t, found, distinct, agreed: distinct.length <= 1, version: distinct[0] ?? "?" };
}

// --- output ------------------------------------------------------------------

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", red: "", green: "", yellow: "", bold: "", off: "" };

function report() {
  let drift = 0;
  console.log(`${C.bold}app          version    sites${C.off}`);
  for (const t of TARGETS) {
    const i = inspect(t);
    if (i.agreed) {
      console.log(`${t.name.padEnd(12)} ${i.version.padEnd(10)} ${C.dim}${i.found.length} in sync${C.off}`);
    } else {
      drift++;
      console.log(`${t.name.padEnd(12)} ${C.red}DRIFT${C.off}      ${C.red}${i.distinct.join(" / ")}${C.off}`);
      for (const s of i.found) console.log(`             ${C.dim}${String(s.value).padEnd(10)} ${s.label}${C.off}`);
    }
  }
  if (drift > 0) {
    console.log(`\n${C.yellow}${drift} app(s) disagree with themselves.${C.off}`);
    console.log(`Reconcile with:  ${C.bold}bun run version <app> --set <version>${C.off}`);
    console.log(`${C.dim}For an Expo app the native value is the one that ships — ios/ is committed,${C.off}`);
    console.log(`${C.dim}so EAS skips prebuild and app.json never reaches the binary.${C.off}`);
  }
  return drift;
}

// --- main --------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const setIdx = argv.indexOf("--set");
const setTo = setIdx >= 0 ? argv[setIdx + 1] : null;
// Guard the `setIdx >= 0` case explicitly: with no --set, setIdx is -1 and
// `setIdx + 1` is 0, which would drop the FIRST positional — the app name.
const setValueIdx = setIdx >= 0 ? setIdx + 1 : -1;
const positional = argv.filter((a, i) => !a.startsWith("--") && i !== setValueIdx);

const dryRun = flags.has("--dry-run");

if (positional.length === 0) {
  process.exit(report() > 0 ? 1 : 0);
}

const [nameArg, levelArg] = positional;
const target = TARGETS.find((t) => t.name === nameArg);
if (!target) {
  console.error(`✗ unknown app "${nameArg}". Known: ${TARGETS.map((t) => t.name).join(", ")}`);
  process.exit(2);
}

const current = inspect(target);

let next;
if (setTo) {
  if (!SEMVER.test(setTo)) { console.error(`✗ "${setTo}" is not a valid x.y.z version`); process.exit(2); }
  next = setTo;
} else if (levelArg) {
  // A drifted app has no single "current" to bump FROM — bumping the wrong one
  // silently picks a winner and buries the disagreement.
  if (!current.agreed) {
    console.error(`✗ ${target.name} disagrees with itself: ${current.distinct.join(" / ")}`);
    for (const s of current.found) console.error(`    ${String(s.value).padEnd(10)} ${s.label}`);
    console.error(`\nPick one explicitly:  bun run version ${target.name} --set <version>`);
    process.exit(1);
  }
  try { next = bump(current.version, levelArg); }
  catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
} else {
  console.error(`✗ say what to do: major | minor | patch | --set <version>`);
  process.exit(2);
}

console.log(`${C.bold}${target.name}${C.off}  ${current.agreed ? current.version : current.distinct.join("/")} → ${C.green}${next}${C.off}${dryRun ? `  ${C.dim}(dry run)${C.off}` : ""}\n`);

for (const s of current.found) {
  const before = fs.readFileSync(s.file, "utf8");
  const after = s.write(before, next);
  const rel = path.relative(ROOT, s.file);
  if (after === before) {
    console.log(`  ${C.dim}·${C.off} ${rel} ${C.dim}(already ${next})${C.off}`);
    continue;
  }
  if (!dryRun) fs.writeFileSync(s.file, after);
  console.log(`  ${C.green}✓${C.off} ${rel} ${C.dim}${s.value} → ${next}${C.off}`);
}

// Writing four files and getting three right is worse than failing, so read
// them all back rather than trusting the replacements.
if (!dryRun) {
  const after = inspect(target);
  if (!after.agreed || after.version !== next) {
    console.error(`\n${C.red}✗ verification failed — files disagree after writing: ${after.distinct.join(" / ")}${C.off}`);
    process.exit(1);
  }
  console.log(`\n${C.green}✓${C.off} ${target.name} is ${next} in all ${after.found.length} places.`);
  if (target.kind === "expo") {
    console.log(`${C.dim}  Build numbers are EAS's (appVersionSource: remote) and were not touched.${C.off}`);
  }
}
