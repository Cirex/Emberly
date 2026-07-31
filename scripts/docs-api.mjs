#!/usr/bin/env bun
/**
 * Generate docs/Web-API.md from the route handlers themselves.
 *
 *   bun run docs:api           # write docs/Web-API.md
 *   bun run docs:api --check   # fail if the committed doc is stale (CI)
 *
 * GENERATED, NOT WRITTEN, on purpose. A hand-maintained API reference across
 * 110 routes is stale the day after it is written — this repo already learned
 * that the expensive way with schema.sql, which claimed to provision a database
 * and had been missing a `set search_path` on a SECURITY DEFINER function since
 * July. Anything derived from source belongs in a generator; the prose that a
 * generator cannot know lives in the route's own docblock, next to the code it
 * describes, where it gets updated in the same edit.
 *
 * So: to change this document, change the route.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const API_DIR = path.join(ROOT, "apps/web/app/api");
const OUT = path.join(ROOT, "docs/Web-API.md");

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

// --- source walking ----------------------------------------------------------

function routeFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(p, acc);
    else if (entry.name === "route.ts") acc.push(p);
  }
  return acc;
}

/** apps/web/app/api/resman/units/[id]/route.ts -> /api/resman/units/:id */
function urlPath(file) {
  const rel = path.relative(API_DIR, path.dirname(file));
  const segs = rel === "" ? [] : rel.split(path.sep);
  return "/api/" + segs
    .map((s) => s.replace(/^\[\.\.\.(.+)\]$/, "*$1").replace(/^\[(.+)\]$/, ":$1"))
    .join("/");
}

/**
 * The `/** ... *\/` block immediately above an index, if any.
 *
 * Anchored to the export it documents rather than to the file, because a file
 * with GET and POST usually documents them separately and attributing both to
 * the first one would put the wrong description on the second.
 */
function docblockBefore(src, index) {
  const before = src.slice(0, index);
  const close = before.lastIndexOf("*/");
  if (close === -1) return null;
  // Only if nothing but whitespace sits between the comment and the export.
  if (before.slice(close + 2).trim() !== "") return null;
  const open = before.lastIndexOf("/**", close);
  if (open === -1) return null;
  return before
    .slice(open + 3, close)
    .split("\n")
    .map((l) => l.replace(/^\s*\*ic?/, "").replace(/^\s*\*/, "").trim())
    .join("\n")
    .trim();
}

/** Balanced-brace slice starting at the `{` at or after `from`. */
function objectAt(src, from) {
  const start = src.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** Top-level keys of an object literal, ignoring anything nested. */
function topLevelKeys(objSrc) {
  const body = objSrc.slice(1, -1);
  const keys = [];
  let depth = 0, inStr = null, atKey = true, buf = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (inStr) { if (c === inStr && body[i - 1] !== "\\") inStr = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if ("{[(".includes(c)) { depth += 1; continue; }
    if ("}])".includes(c)) { depth -= 1; continue; }
    if (depth > 0) continue;
    if (c === ":" && atKey) { keys.push(buf.trim()); buf = ""; atKey = false; continue; }
    if (c === ",") {
      // A bare identifier with no colon is shorthand: { data } -> key "data".
      if (atKey && buf.trim()) keys.push(buf.trim());
      buf = ""; atKey = true; continue;
    }
    if (atKey) buf += c;
  }
  if (atKey && buf.trim()) keys.push(buf.trim());
  return keys
    .map((k) => k.replace(/^\.\.\./, "…").replace(/\s+/g, " "))
    .filter((k) => k && !k.startsWith("//"));
}

/** Every NextResponse.json(...) in a slice, as { status, keys }. */
function responses(slice) {
  const out = [];
  const re = /NextResponse\.json\(/g;
  let m;
  while ((m = re.exec(slice))) {
    const argStart = m.index + m[0].length;
    const rest = slice.slice(argStart);
    let keys = [];
    if (rest.trimStart().startsWith("{")) {
      const obj = objectAt(slice, argStart);
      if (obj) keys = topLevelKeys(obj);
    } else {
      const ident = rest.match(/^\s*([A-Za-z_$][\w$.]*)/);
      keys = ident ? [`(${ident[1]})`] : [];
    }
    // The init object carrying `status` follows the payload.
    const after = slice.slice(argStart, argStart + 900);
    const status = after.match(/\{\s*status:\s*(\d{3})/);
    out.push({ status: status ? Number(status[1]) : 200, keys });
  }
  return out;
}

/**
 * Which guard protects this handler, and what capability it demands.
 *
 * Order matters: the FIRST match wins, so the most specific guard has to come
 * before a more general one it wraps. `requireStaffToken` sits above
 * `requireResmanApiKey` because a route calling both is really staff-gated.
 *
 * This list is checked against the source by scripts/docs-api.mjs's own
 * reporting: anything guard-shaped that is not here shows up in the "no guard
 * recognised" list at the end of a run, so a new guard cannot silently make a
 * route look public.
 */
const GUARDS = [
  { fn: "requireStaffToken", label: "staff bearer token" },
  { fn: "requireAdminOrScanner", label: "admin session or scanner key" },
  { fn: "requireResmanApiKey", label: "ResMan API key" },
  { fn: "requireAdmin", label: "admin session" },
  { fn: "verifyAdminRequest", label: "admin session" },
  { fn: "verifyAdminKey", label: "admin session" },
  { fn: "authenticateMapSyncRequest", label: "map sync key" },
  { fn: "authenticateScanner", label: "scanner key" },
  { fn: "hasScannerCredential", label: "scanner key" },
  { fn: "verifyResidentDeviceSession", label: "resident device token" },
  { fn: "verifyResidentSelectionToken", label: "resident selection token" },
  { fn: "verifyResidentEntryToken", label: "resident entry token" },
  { fn: "verifyGuestEntryToken", label: "guest entry token" },
  { fn: "verifyGuestPassRecord", label: "guest pass token" },
  { fn: "verifySignedResmanPortalSession", label: "signed ResMan portal session" },
  { fn: "verifyResmanPortalAccess", label: "ResMan portal credentials" },
  { fn: "authenticateResmanAdmin", label: "ResMan staff credentials" },
  { fn: "authenticateBreakGlass", label: "break-glass key" },
  { fn: "authenticateMcp", label: "MCP bearer token" },
  { fn: "requireResidentAuth", label: "resident device token" },
  { fn: "requireScanner", label: "scanner key" },
  { fn: "requireMcpAuth", label: "MCP bearer token" },
  { fn: "verifyRequest", label: "signed Emberly token" },
];

function scanGuard(slice) {
  for (const g of GUARDS) {
    const m = slice.match(new RegExp(`${g.fn}\\s*\\(([^)]*)\\)`));
    if (!m) continue;
    const cap = m[1].match(/["']([^"']+)["']/);
    return { label: g.label, capability: cap ? cap[1] : null };
  }
  if (/CRON_SECRET/.test(slice)) return { label: "cron secret (bearer)", capability: null };
  return null;
}

/**
 * Route factories. `export const GET = createListRoute(unitsResource)` puts the
 * guard inside the factory, not the route file — 22 of 132 handlers.
 *
 * Resolved once from the module that defines them rather than assumed: a
 * generator that reported "no auth" for a fifth of the surface would be worse
 * than no document at all, because a reader would take it for "public".
 */
const FACTORY_SOURCE = path.join(ROOT, "apps/web/lib/resman-api.ts");
const factoryGuards = new Map();
if (fs.existsSync(FACTORY_SOURCE)) {
  const src = fs.readFileSync(FACTORY_SOURCE, "utf8");
  for (const m of src.matchAll(/export\s+function\s+(create\w*Route)\b/g)) {
    const guard = scanGuard(src.slice(m.index, m.index + 3000));
    if (guard) factoryGuards.set(m[1], guard);
  }
}

/** Bodies of functions declared in this file, so a handler that delegates resolves. */
function localFunctions(src) {
  const out = new Map();
  const re = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1] ?? m[2];
    out.set(name, src.slice(m.index, m.index + 2500));
  }
  return out;
}

/**
 * The guard protecting a handler, following one level of indirection:
 * the handler body, then any same-file helper it calls, then the factory it
 * was built from. `/api/cron/monitor` is the reason for the middle case — its
 * bearer check lives in a `hasCronBearer` helper above the export.
 */
/**
 * Routes that are unauthenticated ON PURPOSE, with the reason.
 *
 * Spelled out so "no guard" in the generated doc always means "nobody has
 * looked at this", never "this is fine". Each was read before being listed.
 */
const PUBLIC = {
  "GET /api/health": "liveness probe — returns no data",
  "POST /api/admin/logout": "clears the session cookie; requiring the session to drop it would strand a bad one",
  "GET /api/mcp": "returns 405 with `Allow: POST` — the MCP surface authenticates on POST",
  "POST /api/map/access-requests":
    "device enrolment REQUEST — unauthenticated by definition, since the caller has no credential yet. Rate limited by source; grants nothing until an admin approves.",
  "POST /api/map/access-requests/:requestId/claim":
    "redeems an admin-approved request with a one-time claim code. The code is the credential. Rate limited by source.",
};

function guardFor(slice, src, locals) {
  const direct = scanGuard(slice);
  if (direct) return direct;

  for (const [name, body] of locals) {
    if (!new RegExp(`\\b${name}\\s*\\(`).test(slice)) continue;
    const nested = scanGuard(body);
    if (nested) return nested;
  }

  // The method regex already consumed the `=`, so the factory call is at the
  // START of the slice — matching on `= name(` here found nothing and quietly
  // reported 22 guarded routes as unguarded.
  const factory = slice.match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
  if (factory && factoryGuards.has(factory[1])) {
    return { ...factoryGuards.get(factory[1]), via: factory[1] };
  }
  return null;
}

// --- extraction --------------------------------------------------------------

function parseRoute(file) {
  const src = fs.readFileSync(file, "utf8");
  const url = urlPath(file);
  const locals = localFunctions(src);
  const handlers = [];

  for (const method of METHODS) {
    const re = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+${method}\\b|const\\s+${method}\\s*[:=])`);
    const m = re.exec(src);
    if (!m) continue;

    // Slice to the next export so responses are attributed to the right method.
    const after = src.slice(m.index + m[0].length);
    const nextExport = after.search(/\nexport\s+(async\s+)?(function|const)\s/);
    const slice = (nextExport === -1 ? after : after.slice(0, nextExport));

    handlers.push({
      method,
      doc: docblockBefore(src, m.index),
      guard: guardFor(slice, src, locals),
      responses: responses(slice),
    });
  }

  // A file-level docblock (before the first import) describes the whole route.
  const fileDoc = src.startsWith("/**") ? docblockBefore(src, src.indexOf("*/") + 2) : null;
  return { file: path.relative(ROOT, file), url, handlers, fileDoc };
}

// --- rendering ---------------------------------------------------------------

/** Top-level group for the table of contents. */
function groupOf(url) {
  const seg = url.split("/")[2] ?? "";
  return seg || "root";
}

const GROUP_NOTES = {
  admin: "Browser-facing routes behind the admin session cookie. These back the `/admin` dashboard.",
  resman: "The staff API. Bearer-token routes consumed by the maintenance, security and manager apps.",
  resident: "Resident-facing routes, authenticated by a per-device token rather than a staff identity.",
  map: "Property-map annotations and the sync key exchange used by the security app.",
  mlgw: "Memphis Light Gas & Water utility billing.",
  auth: "Sign-in and session issuance.",
  cron: "Scheduled jobs. Bearer `CRON_SECRET`, not a user identity.",
  mcp: "The Model Context Protocol server. See [MCP Tools](MCP-Tools.md) for the tool surface.",
  scanner: "Gate-scanner device enrolment.",
  health: "Liveness probe.",
  "verify-pass": "Guest-pass verification, called by the scanner at the gate.",
  "entry-logs": "Gate entry records.",
};

function render(routes) {
  const byGroup = new Map();
  for (const r of routes) {
    const g = groupOf(r.url);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(r);
  }
  const groups = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length);

  const L = [];
  L.push("# Web API");
  L.push("");
  L.push("> **Generated from the route handlers by `bun run docs:api`. Do not edit by hand —");
  L.push("> change the route's docblock and regenerate.** Each entry's prose is the docblock");
  L.push("> above that handler, so it lives next to the code and is updated in the same edit.");
  L.push("");
  L.push(`${routes.length} routes, ${routes.reduce((n, r) => n + r.handlers.length, 0)} handlers.`);
  L.push("");

  L.push("## Conventions");
  L.push("");
  L.push("**Success payloads are wrapped.** Most routes return `{ data: … }` rather than a bare");
  L.push("array or object, so a response can grow a sibling field (`meta`, `note`) without");
  L.push("breaking a client that destructures `data`.");
  L.push("");
  L.push("**Errors are `{ error: string }`** with a non-2xx status. The message is meant for a");
  L.push("developer, not an end user — it is not localized and should not be shown verbatim.");
  L.push("");
  L.push("**Auth is per-route, not per-prefix.** The guard column below is the function the");
  L.push("handler actually calls. Where a guard takes a capability string, that capability is");
  L.push("shown — a token without it gets 403 even though it authenticated fine.");
  L.push("");
  L.push("| status | meaning |");
  L.push("| --- | --- |");
  L.push("| 200 | success |");
  L.push("| 202 | accepted — notification-only JSON-RPC, no body |");
  L.push("| 400 | malformed request: bad JSON, missing or invalid parameter |");
  L.push("| 401 | no credential, or one that did not verify |");
  L.push("| 403 | authenticated, but not permitted this capability or resource |");
  L.push("| 404 | no such row, or a route that hides existence deliberately |");
  L.push("| 409 | conflict with current state |");
  L.push("| 429 | rate limited |");
  L.push("| 500 | unhandled server error — the detail is logged, not returned |");
  L.push("");

  L.push("## Contents");
  L.push("");
  for (const [g, rs] of groups) L.push(`- [\`/api/${g}\`](#api${g.replace(/[^a-z0-9]/g, "")}) — ${rs.length} route${rs.length === 1 ? "" : "s"}`);
  L.push("");

  for (const [g, rs] of groups) {
    L.push(`## /api/${g}`);
    L.push("");
    if (GROUP_NOTES[g]) { L.push(GROUP_NOTES[g]); L.push(""); }

    for (const r of rs.sort((a, b) => a.url.localeCompare(b.url))) {
      for (const h of r.handlers) {
        L.push(`### \`${h.method} ${r.url}\``);
        L.push("");
        const doc = h.doc ?? r.fileDoc;
        if (doc) { L.push(doc); L.push(""); }

        const guard = h.guard;
        const publicReason = PUBLIC[`${h.method} ${r.url}`];
        if (guard) {
          L.push(`- **Auth** — ${guard.label}${guard.capability ? `, capability \`${guard.capability}\`` : ""}${guard.via ? ` (via \`${guard.via}\`)` : ""}`);
        } else if (publicReason) {
          L.push(`- **Auth** — **public by design** — ${publicReason}`);
        } else {
          L.push("- **Auth** — ⚠️ _no guard found by the generator; verify before relying on this_");
        }

        const byStatus = new Map();
        for (const res of h.responses) {
          const key = res.status;
          if (!byStatus.has(key)) byStatus.set(key, new Set());
          for (const k of res.keys) byStatus.get(key).add(k);
        }
        if (byStatus.size > 0) {
          L.push("- **Returns**");
          for (const [status, keys] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
            const shape = keys.size ? `\`{ ${[...keys].join(", ")} }\`` : "_no body_";
            L.push(`  - \`${status}\` → ${shape}`);
          }
        }
        L.push(`- **Source** — [\`${r.file}\`](../${r.file})`);
        L.push("");
      }
    }
  }

  L.push("---");
  L.push("");
  L.push("_Regenerate with `bun run docs:api`._");
  L.push("");
  return L.join("\n");
}

// --- main --------------------------------------------------------------------

const routes = routeFiles(API_DIR).map(parseRoute).filter((r) => r.handlers.length > 0);
const out = render(routes);

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== out) {
    console.error("✗ docs/Web-API.md is stale — run `bun run docs:api`");
    process.exit(1);
  }
  console.log("✓ docs/Web-API.md is current");
} else {
  fs.writeFileSync(OUT, out);
  const handlers = routes.reduce((n, r) => n + r.handlers.length, 0);
  const unguarded = routes
    .flatMap((r) => r.handlers.filter((h) => !h.guard).map((h) => `${h.method} ${r.url}`))
    .filter((k) => !PUBLIC[k]);
  console.log(`✓ docs/Web-API.md — ${routes.length} routes, ${handlers} handlers`);
  if (unguarded.length) {
    console.log(`\n  ${unguarded.length} handler(s) with no guard the generator recognises:`);
    for (const u of unguarded) console.log(`    ${u}`);
    console.log("  (not in the PUBLIC allowlist either — read them before shipping this doc)");
  }
}
