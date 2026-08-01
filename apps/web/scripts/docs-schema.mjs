#!/usr/bin/env bun
/**
 * Generate docs/Database.md — every table, every column, and how they join.
 *
 *   bun run docs:schema           # write docs/Database.md
 *   bun run docs:schema --check   # fail if the committed doc is stale (CI)
 *
 * Structure comes from the DATABASE (a scratch Postgres built from schema.sql,
 * so no credentials and no production round-trip); prose comes from the comment
 * block above each `create table` in schema.sql. Both are already maintained —
 * this only assembles them, so it cannot drift from either.
 *
 * The part worth reading is the reference graph. This schema declares 37
 * foreign keys across 55 tables, so MOST relationships are convention: a text
 * column holding another table's id with nothing enforcing it. Those joins work
 * exactly like real ones right up until they don't, and no `\d` output will
 * warn you. They are inferred and labelled separately here.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

// apps/web/scripts -> repo root. This generator lives beside
// apply-supabase-migrations.mjs because both need `pg`, which resolves from
// apps/web rather than the workspace root.
const ROOT = path.resolve(import.meta.dir, "../../..");
const SCHEMA_SQL = path.join(ROOT, "apps/web/lib/supabase/schema.sql");
const OUT = path.join(ROOT, "docs/Database.md");
const SCRATCH_DB = process.env.DOCS_DB_URL ?? "postgres://postgres:scratch@localhost:55432/emberly_docs";

// --- prose from schema.sql ---------------------------------------------------

/** The `--` comment block immediately above each `create table`. */
function proseByTable() {
  const src = fs.readFileSync(SCHEMA_SQL, "utf8");
  const out = new Map();
  for (const m of src.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)\s*\(/g)) {
    const before = src.slice(Math.max(0, m.index - 2000), m.index);
    const block = [];
    for (const line of before.split("\n").reverse()) {
      const t = line.trim();
      if (t.startsWith("--") || t === "") block.push(line);
      else break;
    }
    const text = block.reverse().join("\n")
      .replace(/^\s*-{2,}\s?/gm, "")
      .replace(/^={5,}$/gm, "")
      .replace(/^-{5,}$/gm, "")
      .split("\n").map((l) => l.trim()).join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text.length > 20) out.set(m[1], text);
  }
  return out;
}

/** Per-column trailing `-- comment` inside a create table body. */
function columnNotes() {
  const src = fs.readFileSync(SCHEMA_SQL, "utf8");
  const out = new Map();
  for (const m of src.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const table = m[1];
    for (const line of m[2].split("\n")) {
      const c = line.match(/^\s*(\w+)\s+[^-]*--\s*(.+)$/);
      if (c) out.set(`${table}.${c[1]}`, c[2].trim());
    }
  }
  return out;
}

// --- structure from the database --------------------------------------------

/**
 * Load schema.sql into the scratch database if it is not already there.
 *
 * Self-contained so `bun run docs:schema` is one command against any empty
 * Postgres — no production credentials, and nothing to remember to run first.
 * The Supabase-only bits schema.sql touches (storage buckets, the anon /
 * authenticated / service_role roles) are stubbed; they are not part of the
 * relational structure being documented.
 */
async function ensureLoaded() {
  const client = new Client({ connectionString: SCRATCH_DB, ssl: false });
  await client.connect();

  // ALWAYS rebuild. This used to skip when the database already had tables,
  // which meant a scratch database left over from an earlier run silently
  // produced a document describing the OLD schema — it reported two dropped
  // tables as still present. A doc generator that can go stale is the exact
  // failure it exists to prevent, and reloading costs about a second.
  await client.query("drop schema public cascade");
  await client.query("create schema public");
  await client.query("drop schema if exists storage cascade");

  await client.query("create extension if not exists pgcrypto");
  for (const role of ["anon", "authenticated", "service_role"]) {
    await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname='${role}') then create role ${role} nologin; end if;
    end $$;`);
  }
  await client.query("create schema if not exists storage");
  await client.query(`create table if not exists storage.buckets (
    id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[])`);
  await client.query(fs.readFileSync(SCHEMA_SQL, "utf8"));
  await client.end();
}

async function introspect() {
  await ensureLoaded();
  const client = new Client({ connectionString: SCRATCH_DB, ssl: false });
  await client.connect();
  const q = async (sql) => (await client.query(sql)).rows;
  const data = {
    tables: await q(`select table_name from information_schema.tables
                     where table_schema='public' and table_type='BASE TABLE' order by table_name`),
    columns: await q(`select table_name, column_name, data_type, udt_name, is_nullable,
                             coalesce(column_default,'') as column_default, ordinal_position
                      from information_schema.columns where table_schema='public'
                      order by table_name, ordinal_position`),
    pks: await q(`select rel.relname as table_name, a.attname as column_name
                  from pg_constraint con
                  join pg_class rel on rel.oid=con.conrelid
                  join pg_namespace n on n.oid=rel.relnamespace
                  join unnest(con.conkey) k(attnum) on true
                  join pg_attribute a on a.attrelid=rel.oid and a.attnum=k.attnum
                  where n.nspname='public' and con.contype='p'`),
    // Constraint count, not constrained-column count: a composite foreign key
    // is ONE relationship, and the per-column query below expands it to two.
    fkCount: await q(`select count(*)::int n from pg_constraint con
                      join pg_class rel on rel.oid=con.conrelid
                      join pg_namespace n on n.oid=rel.relnamespace
                      where n.nspname='public' and con.contype='f'`),
    fks: await q(`select rel.relname as table_name, a.attname as column_name,
                         frel.relname as ref_table, fa.attname as ref_column,
                         pg_get_constraintdef(con.oid) as def
                  from pg_constraint con
                  join pg_class rel on rel.oid=con.conrelid
                  join pg_class frel on frel.oid=con.confrelid
                  join pg_namespace n on n.oid=rel.relnamespace
                  join unnest(con.conkey) with ordinality k(attnum, ord) on true
                  join unnest(con.confkey) with ordinality fk(attnum, ord) on fk.ord=k.ord
                  join pg_attribute a on a.attrelid=rel.oid and a.attnum=k.attnum
                  join pg_attribute fa on fa.attrelid=frel.oid and fa.attnum=fk.attnum
                  where n.nspname='public' and con.contype='f'
                  order by rel.relname, a.attname`),
    uniques: await q(`select rel.relname as table_name, a.attname as column_name
                      from pg_constraint con
                      join pg_class rel on rel.oid=con.conrelid
                      join pg_namespace n on n.oid=rel.relnamespace
                      join unnest(con.conkey) k(attnum) on true
                      join pg_attribute a on a.attrelid=rel.oid and a.attnum=k.attnum
                      where n.nspname='public' and con.contype='u'`),
    checks: await q(`select rel.relname as table_name, con.conname,
                            pg_get_constraintdef(con.oid) as def
                     from pg_constraint con
                     join pg_class rel on rel.oid=con.conrelid
                     join pg_namespace n on n.oid=rel.relnamespace
                     where n.nspname='public' and con.contype='c' order by rel.relname`),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes
                      where schemaname='public' order by tablename, indexname`),
    rls: await q(`select c.relname, c.relrowsecurity from pg_class c
                  join pg_namespace n on n.oid=c.relnamespace
                  where n.nspname='public' and c.relkind='r'`),
  };
  await client.end();
  return data;
}

// --- the reference graph ------------------------------------------------------

/**
 * Joins nothing enforces.
 *
 * A column is treated as an implied reference when its name is the PRIMARY KEY
 * column name of some other table (`resman_unit_id` is the pk of resman_units)
 * and no foreign key already covers it. That rule is narrow on purpose: it
 * produces joins someone could actually write, and it does not guess from
 * loose name similarity.
 *
 * These are not lesser relationships — `resman_units.resman_property_id` is
 * load-bearing. They are simply unenforced, so a delete on the parent leaves
 * orphans, and a typo'd id inserts happily.
 */
function inferReferences(db) {
  const pkCount = new Map();
  for (const p of db.pks) pkCount.set(p.table_name, (pkCount.get(p.table_name) ?? 0) + 1);

  // Candidate owners per column name. Several tables can share one — both
  // `resman_units` and `guest_pass_unit_bans` are keyed on `resman_unit_id` —
  // so picking the first alphabetically made a table's OWN primary key look
  // like a reference to a child that merely borrows the name.
  const candidates = new Map();
  for (const p of db.pks) {
    if (pkCount.get(p.table_name) !== 1) continue; // composite pk column is not an id
    if (!candidates.has(p.column_name)) candidates.set(p.column_name, []);
    candidates.get(p.column_name).push(p.table_name);
  }

  /** `resman_unit_id` -> `resman_units`: the table the name itself points at. */
  function ownerOf(column) {
    const list = candidates.get(column);
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const stem = column.replace(/_id$/, "");
    const byName = list.find((t) => t === `${stem}s` || t === stem || t === `${stem}es`);
    // Ambiguous with no name match: say nothing rather than guess wrong.
    return byName ?? null;
  }

  const declared = new Set(db.fks.map((f) => `${f.table_name}.${f.column_name}`));
  const ownPk = new Set(db.pks.map((p) => `${p.table_name}.${p.column_name}`));
  const implied = [];
  for (const c of db.columns) {
    const key = `${c.table_name}.${c.column_name}`;
    if (declared.has(key)) continue;
    // A table's own key is an identity, not a reference.
    if (ownPk.has(key)) continue;
    const owner = ownerOf(c.column_name);
    if (!owner || owner === c.table_name) continue;
    implied.push({ table: c.table_name, column: c.column_name, ref_table: owner, ref_column: c.column_name });
  }
  return implied;
}

/**
 * Reference columns that hold DIFFERENT KINDS of id depending on a sibling
 * column. Neither a foreign key nor an inferred one can express these, and
 * getting them wrong is how the access_tokens cleanup task got filed.
 */
const POLYMORPHIC = {
  "access_tokens.subject_id": {
    discriminator: "subject_type",
    targets: "`admin_user` → `admin_users.id`; `scanner` → `scanner_devices.scanner_id`",
    warning:
      "In production TWO active rows hold the ResMan *username* here instead of the uuid. " +
      "The column is plain text with nothing enforcing either shape, so a username rename " +
      "silently orphans a live bearer token that keeps authenticating.",
  },
  "access_token_audit_log.subject_id": { discriminator: "subject_type", targets: "as `access_tokens.subject_id`" },
  "admin_alerts.subject_id": { discriminator: "subject_type", targets: "varies by alert kind" },
  "admin_audit_logs.admin_user_id": { discriminator: null, targets: "`admin_users.id`, as text" },
};

// --- rendering ----------------------------------------------------------------

const anchor = (s) => s.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

function typeOf(c) {
  if (c.data_type === "ARRAY") return `${c.udt_name.replace(/^_/, "")}[]`;
  if (c.data_type === "USER-DEFINED") return c.udt_name;
  return { "timestamp with time zone": "timestamptz", "character varying": "varchar",
           "timestamp without time zone": "timestamp", "double precision": "float8" }[c.data_type] ?? c.data_type;
}

function render(db, prose, notes) {
  const implied = inferReferences(db);
  const cols = new Map();
  for (const c of db.columns) {
    if (!cols.has(c.table_name)) cols.set(c.table_name, []);
    cols.get(c.table_name).push(c);
  }
  const pk = new Map();
  for (const p of db.pks) {
    if (!pk.has(p.table_name)) pk.set(p.table_name, new Set());
    pk.get(p.table_name).add(p.column_name);
  }
  const uniq = new Set(db.uniques.map((u) => `${u.table_name}.${u.column_name}`));
  const fkBy = new Map();
  for (const f of db.fks) fkBy.set(`${f.table_name}.${f.column_name}`, f);
  const impliedBy = new Map();
  for (const i of implied) impliedBy.set(`${i.table}.${i.column}`, i);
  const inbound = new Map();
  for (const f of db.fks) {
    if (!inbound.has(f.ref_table)) inbound.set(f.ref_table, []);
    inbound.get(f.ref_table).push({ ...f, kind: "fk" });
  }
  for (const i of implied) {
    if (!inbound.has(i.ref_table)) inbound.set(i.ref_table, []);
    inbound.get(i.ref_table).push({ table_name: i.table, column_name: i.column, kind: "implied" });
  }
  const checksBy = new Map();
  for (const c of db.checks) {
    if (!checksBy.has(c.table_name)) checksBy.set(c.table_name, []);
    checksBy.get(c.table_name).push(c);
  }
  const rlsOn = new Set(db.rls.filter((r) => r.relrowsecurity).map((r) => r.relname));

  // Families, by table-name prefix — the schema is four systems in one database.
  const FAMILIES = [
    { key: "resman_", title: "ResMan mirror", note: "Read-only copies of the property-management system, rewritten in full by the sync worker. Nothing here is authored by Emberly — a write would be overwritten on the next pass." },
    { key: "mlgw_", title: "Utilities (MLGW)", note: "Memphis Light Gas & Water billing: accounts, bills, payments, and the exception reviews staff record against them." },
    { key: "map_", title: "Property map", note: "The annotation layer the security app draws on, plus the key exchange that lets a device sync it." },
    { key: "guest_pass", title: "Guest passes", note: "Resident-issued visitor passes and the bans that suspend them." },
    { key: "admin_", title: "Admin & audit", note: "Staff accounts, the alert feed, and the audit trails." },
    { key: "access_token", title: "Bearer tokens", note: "Hash-only storage for MCP and API tokens, their use log, and their permission-change trail." },
    { key: "pm_", title: "Preventive maintenance", note: "Recurring maintenance templates and the per-unit task rounds generated from them." },
    { key: "entry_log", title: "Gate entry", note: "Scanner records. Currently EMPTY in production — the scanners have never been used, so a zero here is not a quiet night." },
    { key: "resident", title: "Residents", note: "Resident identities and their enrolled devices." },
  ];
  const familyOf = (t) => FAMILIES.find((f) => t.startsWith(f.key))?.title ?? "Everything else";

  const grouped = new Map();
  for (const t of db.tables.map((r) => r.table_name)) {
    const fam = familyOf(t);
    if (!grouped.has(fam)) grouped.set(fam, []);
    grouped.get(fam).push(t);
  }
  const order = [...FAMILIES.map((f) => f.title), "Everything else"].filter((f) => grouped.has(f));

  const L = [];
  L.push("# Database");
  L.push("");
  L.push("> **Generated by `bun run docs:schema`. Do not edit by hand.** Structure is read from");
  L.push("> a database built from `apps/web/lib/supabase/schema.sql`; prose is the comment block");
  L.push("> above each `create table` in that same file. To change this document, change the");
  L.push("> schema or its comments.");
  L.push("");
  L.push(`${db.tables.length} tables · ${db.columns.length} columns · **${db.fkCount[0].n} declared foreign keys** · ${implied.length} inferred references`);
  L.push("");

  L.push("## How to read the relationships");
  L.push("");
  L.push("This is the part that will bite you, so it comes first.");
  L.push("");
  L.push(`Only **${db.fkCount[0].n}** relationships across ${db.tables.length} tables are declared foreign keys. The rest are`);
  L.push("**convention**: a column holding another table's id, with nothing in the database");
  L.push("enforcing it. Both join identically in a query. They differ in every other way:");
  L.push("");
  L.push("| | declared FK | convention only |");
  L.push("| --- | --- | --- |");
  L.push("| Join works | yes | yes |");
  L.push("| Bad id rejected on insert | yes | **no** |");
  L.push("| Parent delete blocked or cascaded | yes | **no — orphans** |");
  L.push("| PostgREST/Supabase embed (`select=*,other(*)`) | yes | **no** |");
  L.push("| Visible to schema tooling | yes | **no** |");
  L.push("");
  L.push("The MCP server's `related` filter is built on declared FKs, which is why some");
  L.push("resource pairs cannot be joined there even though the columns obviously correspond —");
  L.push("`units → transactions` is the standing example.");
  L.push("");
  L.push("Below, **→ FK** is enforced and **→ ref** is convention. An inferred reference means");
  L.push("the column carries the exact name of another table's single-column primary key; it is");
  L.push("a strong signal, not a guarantee.");
  L.push("");

  const poly = Object.entries(POLYMORPHIC);
  if (poly.length) {
    L.push("### Columns that hold more than one kind of id");
    L.push("");
    L.push("Neither kind of reference describes these — what they point at depends on a sibling");
    L.push("column, so no constraint and no inference can cover them.");
    L.push("");
    for (const [key, p] of poly) {
      L.push(`- **\`${key}\`** — ${p.discriminator ? `discriminated by \`${p.discriminator}\`. ` : ""}${p.targets}`);
      if (p.warning) L.push(`  - ⚠️ ${p.warning}`);
    }
    L.push("");
  }

  L.push("## Contents");
  L.push("");
  for (const fam of order) {
    L.push(`**${fam}** — ${grouped.get(fam).map((t) => `[\`${t}\`](#${anchor(t)})`).join(", ")}`);
    L.push("");
  }

  for (const fam of order) {
    L.push(`## ${fam}`);
    L.push("");
    const famNote = FAMILIES.find((f) => f.title === fam)?.note;
    if (famNote) { L.push(famNote); L.push(""); }

    for (const t of grouped.get(fam)) {
      L.push(`### \`${t}\``);
      L.push("");
      if (prose.has(t)) { L.push(prose.get(t)); L.push(""); }

      L.push("| column | type | null | key | references | notes |");
      L.push("| --- | --- | --- | --- | --- | --- |");
      for (const c of cols.get(t) ?? []) {
        const key = `${t}.${c.column_name}`;
        const flags = [];
        if (pk.get(t)?.has(c.column_name)) flags.push("**PK**");
        if (uniq.has(key)) flags.push("UQ");
        let ref = "";
        const fk = fkBy.get(key);
        const imp = impliedBy.get(key);
        if (fk) ref = `→ FK [\`${fk.ref_table}.${fk.ref_column}\`](#${anchor(fk.ref_table)})`;
        else if (imp) ref = `→ ref [\`${imp.ref_table}.${imp.ref_column}\`](#${anchor(imp.ref_table)})`;
        else if (POLYMORPHIC[key]) ref = "→ _polymorphic, see above_";
        const note = notes.get(key) ?? "";
        const def = c.column_default && !c.column_default.startsWith("nextval")
          ? `default \`${c.column_default.replace(/::[\w ]+/g, "").slice(0, 32)}\``
          : "";
        L.push(`| \`${c.column_name}\` | ${typeOf(c)} | ${c.is_nullable === "YES" ? "yes" : "no"} | ${flags.join(" ")} | ${ref} | ${[note, def].filter(Boolean).join(" · ")} |`);
      }
      L.push("");

      const back = inbound.get(t) ?? [];
      if (back.length) {
        const fks = back.filter((b) => b.kind === "fk");
        const refs = back.filter((b) => b.kind === "implied");
        L.push("**Referenced by** — " + [
          ...fks.map((b) => `[\`${b.table_name}.${b.column_name}\`](#${anchor(b.table_name)}) (FK)`),
          ...refs.map((b) => `[\`${b.table_name}.${b.column_name}\`](#${anchor(b.table_name)})`),
        ].join(", "));
        L.push("");
      }

      const ch = (checksBy.get(t) ?? []).filter((c) => /IN \(|= ANY/.test(c.def));
      if (ch.length) {
        L.push("**Allowed values**");
        L.push("");
        for (const c of ch) {
          const col = c.conname.replace(new RegExp(`^${t}_`), "").replace(/_check$/, "");
          const vals = [...c.def.matchAll(/'([^']+)'::text/g)].map((m) => `\`${m[1]}\``);
          if (vals.length) L.push(`- \`${col}\` — ${vals.join(", ")}`);
        }
        L.push("");
      }

      if (!rlsOn.has(t)) {
        L.push("> ⚠️ Row-level security is **not** enabled on this table.");
        L.push("");
      }
    }
  }

  L.push("---");
  L.push("");
  L.push("_Regenerate with `bun run docs:schema`._");
  L.push("");
  return L.join("\n");
}

// --- main ---------------------------------------------------------------------

const db = await introspect();
const out = render(db, proseByTable(), columnNotes());

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== out) { console.error("✗ docs/Database.md is stale — run `bun run docs:schema`"); process.exit(1); }
  console.log("✓ docs/Database.md is current");
} else {
  fs.writeFileSync(OUT, out);
  console.log(`✓ docs/Database.md — ${db.tables.length} tables, ${db.columns.length} columns, ${db.fkCount[0].n} FK constraints, ${inferReferences(db).length} inferred refs`);
}
