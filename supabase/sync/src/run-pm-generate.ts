/**
 * Runnable entry — generate the current preventive-maintenance round, once.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RESMAN_PROPERTY_ID=... \
 *   bun run sync:pm
 *
 * Reads active pm_templates plus the resman_units / resman_buildings mirrors
 * (never ResMan itself) and inserts the CURRENT period's per-unit pm_tasks.
 * Idempotent: INSERT ... ON CONFLICT (template_id, round_key, unit_number)
 * DO NOTHING, so re-runs never duplicate a round and never clobber tasks
 * already marked done/skipped. (Coolify runs this nightly at the end of
 * sync:all; run it by hand once to verify.)
 */
import { ENV } from "./config/env";
import { type ServiceClient, createServiceClient } from "./db/client";
import {
  type MirrorBuilding,
  type MirrorUnit,
  type PmTaskRow,
  type PmTemplate,
  generatePmTasks,
} from "./pm/generate";

const PAGE = 1000;
const INSERT_BATCH = 500;

/** Page a PostgREST select to completion (unbounded selects cap at 1000 rows). */
async function pageAll<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetchPage(from, from + PAGE - 1);
    if (error) throw new Error(`read ${label} failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

function loadActiveTemplates(supabase: ServiceClient): Promise<PmTemplate[]> {
  return pageAll<PmTemplate>(
    (from, to) =>
      supabase
        .from("pm_templates")
        .select("id, name, cadence, anchor_month, scope_type, scope_values, active")
        .eq("active", true)
        .order("id", { ascending: true })
        .range(from, to),
    "pm_templates",
  );
}

function loadUnits(supabase: ServiceClient, propertyId: string): Promise<MirrorUnit[]> {
  return pageAll<MirrorUnit>(
    (from, to) =>
      supabase
        .from("resman_units")
        .select("number, resman_building_id, classification, excluded_from_occupancy, holding_unit")
        .eq("resman_property_id", propertyId)
        .order("resman_unit_id", { ascending: true })
        .range(from, to),
    "resman_units",
  );
}

function loadBuildings(supabase: ServiceClient, propertyId: string): Promise<MirrorBuilding[]> {
  return pageAll<MirrorBuilding>(
    (from, to) =>
      supabase
        .from("resman_buildings")
        .select("resman_building_id, name")
        .eq("resman_property_id", propertyId)
        .order("resman_building_id", { ascending: true })
        .range(from, to),
    "resman_buildings",
  );
}

/**
 * Insert generated rows with ON CONFLICT DO NOTHING semantics (supabase-js
 * upsert + ignoreDuplicates). RETURNING only yields the rows actually
 * inserted, so `inserted` vs already-existing is exact.
 */
async function insertNewTasks(supabase: ServiceClient, rows: PmTaskRow[]): Promise<Map<string, number>> {
  const insertedByTemplate = new Map<string, number>();
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const chunk = rows.slice(i, i + INSERT_BATCH);
    const { data, error } = await supabase
      .from("pm_tasks")
      .upsert(chunk, { onConflict: "template_id,round_key,unit_number", ignoreDuplicates: true })
      .select("template_id");
    if (error) throw new Error(`insert into pm_tasks failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ template_id: string }>) {
      insertedByTemplate.set(row.template_id, (insertedByTemplate.get(row.template_id) ?? 0) + 1);
    }
  }
  return insertedByTemplate;
}

async function main(): Promise<void> {
  const env = process.env;
  const propertyId = env[ENV.RESMAN_PROPERTY_ID]?.trim();
  if (!propertyId) {
    throw new Error(`Missing required environment variable: ${ENV.RESMAN_PROPERTY_ID}`);
  }
  const supabase = createServiceClient(env);

  const [templates, units, buildings] = await Promise.all([
    loadActiveTemplates(supabase),
    loadUnits(supabase, propertyId),
    loadBuildings(supabase, propertyId),
  ]);
  console.log(
    `[run-pm-generate] loaded ${templates.length} active template(s), ` +
      `${units.length} unit(s), ${buildings.length} building(s)`,
  );

  const rows = generatePmTasks({ templates, units, buildings, nowMs: Date.now() });
  const insertedByTemplate = await insertNewTasks(supabase, rows);

  let inserted = 0;
  for (const template of templates) {
    const generated = rows.filter((r) => r.template_id === template.id);
    const insertedCount = insertedByTemplate.get(template.id) ?? 0;
    inserted += insertedCount;
    const roundKey = generated[0]?.round_key ?? "-";
    console.log(
      `[run-pm-generate] ${template.name} [${roundKey}]: ` +
        `${generated.length} in scope, ${insertedCount} inserted, ` +
        `${generated.length - insertedCount} already existed`,
    );
  }
  console.log(
    "[run-pm-generate] complete:",
    JSON.stringify({
      templates: templates.length,
      generated: rows.length,
      inserted,
      alreadyExisting: rows.length - inserted,
    }),
  );
}

main().catch((error) => {
  console.error("[run-pm-generate] failed:", error);
  process.exit(1);
});
