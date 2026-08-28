/**
 * Flush `maintenance_work_order_edits` → ResMan. The queue half of the
 * work-order write path: the web routes enqueue (durable, deduped), this job
 * drains — one row at a time, through the same authenticated client and
 * request scheduler every scrape uses, under the same "resman" run lock, so a
 * write can never race a scrape.
 *
 * Row lifecycle:
 *   queued ──claim──▶ applying ──▶ applied            (verified on a re-read)
 *                        │
 *                        ├──▶ queued   (nothing was POSTed, or the re-read
 *                        │              proved the save did NOT land — safe to
 *                        │              retry, attempts capped)
 *                        └──▶ failed   (refused by a guard, unresolvable
 *                                       technician, or attempts exhausted)
 *
 * A row whose POST went out but whose verify read failed stays in `applying`;
 * the next run reconciles it with a VERIFY-ONLY read (never a blind re-POST —
 * the save may have landed).
 *
 * This job NEVER writes resman_work_orders. The mirror absorbs the change on
 * the next sync:work-orders pass, which is also what retires the maintenance
 * app's optimistic overlays.
 */

import type { ServiceClient } from "../../db/client";
import type { ResManClient } from "../client";
import type { ResManCredentials } from "../config";
import { ResManScrapingError } from "../errors";
import {
  type ResManEmployee,
  fetchMaintenanceEmployees,
  resolveTechnician,
} from "../write/employees";
import {
  type WorkOrderWriteRequest,
  type WorkOrderWriteResult,
  WorkOrderWriteRefused,
  applyWorkOrderWrite,
  verifyWorkOrderWrite,
} from "../write/work-orders";

export const WRITE_MAX_ATTEMPTS = 5;
/** An `applying` row older than this is presumed interrupted and reconciled. */
export const APPLYING_STALE_MS = 10 * 60 * 1000;
/** Per-run ceiling — writes are serial and polite; a backlog drains over runs. */
const MAX_ROWS_PER_RUN = 25;

export interface QueueRow {
  id: string;
  resman_work_order_id: string;
  kind: "edit" | "close";
  patch: Record<string, unknown>;
  status: string;
  attempts: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface FlushWorkOrderWritesParams {
  client: ResManClient;
  supabase: ServiceClient;
  propertyId: string;
  credentials?: ResManCredentials;
  log?: (message: string) => void;
  /** Injected for tests. */
  now?: () => Date;
  applyWrite?: typeof applyWorkOrderWrite;
  verifyWrite?: typeof verifyWorkOrderWrite;
  fetchEmployees?: typeof fetchMaintenanceEmployees;
}

export interface FlushWorkOrderWritesResult {
  queued: number;
  applied: number;
  requeued: number;
  failed: number;
  /** Rows left in `applying` (verify read failed — reconciled next run). */
  unconfirmed: number;
}

const TABLE = "maintenance_work_order_edits";

/** The patch as the routes wrote it → the writer's request shape. */
function toWriteRequest(
  row: QueueRow,
  expectedUnitId: string | null,
  employees: ResManEmployee[] | null,
): WorkOrderWriteRequest | { error: string } {
  const patch = row.patch ?? {};
  const request: WorkOrderWriteRequest = {
    workOrderId: row.resman_work_order_id,
    kind: row.kind,
    patch: {},
    expectedUnitId,
  };
  if (row.kind === "edit") {
    const technician = patch.technician;
    if (typeof technician === "string") {
      if (/^\s*(unassigned)?\s*$/i.test(technician)) {
        // "Unassigned" (or blank) clears the assignee — no roster needed.
        request.patch.technicianPersonId = "";
      } else {
        if (!employees) return { error: "employee list unavailable" };
        const resolved = resolveTechnician(employees, technician);
        if ("error" in resolved) return { error: resolved.error };
        request.patch.technicianPersonId = resolved.personId;
      }
    }
    if (typeof patch.description === "string") request.patch.description = patch.description;
    if (typeof patch.completionNotes === "string") {
      request.patch.completionNotes = patch.completionNotes;
    }
    if (patch.scheduledAt === null) request.patch.scheduledAt = null;
    else if (typeof patch.scheduledAt === "string") request.patch.scheduledAt = patch.scheduledAt;
    if (
      request.patch.technicianPersonId === undefined &&
      request.patch.description === undefined &&
      request.patch.completionNotes === undefined &&
      request.patch.scheduledAt === undefined
    ) {
      return { error: "edit patch is empty" };
    }
  } else {
    if (typeof patch.note === "string") request.patch.note = patch.note;
    // The tech tapped close at enqueue time; when they did not stamp the
    // moment themselves, the enqueue instant is the truth — never flush time.
    request.patch.completedAt =
      typeof patch.completedAt === "string" ? patch.completedAt : (row.created_at ?? undefined);
  }
  return request;
}

async function updateRow(
  supabase: ServiceClient,
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from(TABLE).update(fields).eq("id", id);
  if (error) throw new Error(`update ${TABLE} failed: ${error.message}`);
}

/** Atomically claim a queued row (queued → applying). False = someone else won. */
async function claimRow(supabase: ServiceClient, row: QueueRow, nowIso: string): Promise<boolean> {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: "applying", attempts: row.attempts + 1, updated_at: nowIso })
    .eq("id", row.id)
    .eq("status", "queued")
    .select("id");
  if (error) throw new Error(`claim ${TABLE} failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

async function loadUnitId(
  supabase: ServiceClient,
  workOrderId: string,
): Promise<{ found: boolean; unitId: string | null }> {
  const { data, error } = await supabase
    .from("resman_work_orders")
    .select("resman_unit_id")
    .eq("resman_work_order_id", workOrderId)
    .maybeSingle();
  if (error) throw new Error(`read resman_work_orders failed: ${error.message}`);
  if (!data) return { found: false, unitId: null };
  return { found: true, unitId: (data as { resman_unit_id: string | null }).resman_unit_id };
}

export async function flushWorkOrderWrites(
  params: FlushWorkOrderWritesParams,
): Promise<FlushWorkOrderWritesResult> {
  const { client, supabase, propertyId } = params;
  const log = params.log ?? (() => {});
  const now = params.now ?? (() => new Date());
  const applyWrite = params.applyWrite ?? applyWorkOrderWrite;
  const verifyWrite = params.verifyWrite ?? verifyWorkOrderWrite;
  const fetchEmployees = params.fetchEmployees ?? fetchMaintenanceEmployees;

  const result: FlushWorkOrderWritesResult = {
    queued: 0,
    applied: 0,
    requeued: 0,
    failed: 0,
    unconfirmed: 0,
  };

  // Queued rows, oldest first, plus stale `applying` rows to reconcile.
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, resman_work_order_id, kind, patch, status, attempts, created_at, updated_at")
    .in("status", ["queued", "applying"])
    .order("created_at", { ascending: true })
    .limit(MAX_ROWS_PER_RUN);
  if (error) throw new Error(`read ${TABLE} failed: ${error.message}`);
  const rows = (data ?? []) as unknown as QueueRow[];
  const staleBefore = now().getTime() - APPLYING_STALE_MS;
  const workable = rows.filter(
    (row) =>
      row.status === "queued" ||
      (row.status === "applying" && Date.parse(row.updated_at ?? "") < staleBefore),
  );
  result.queued = workable.length;
  if (workable.length === 0) return result;

  // Authenticate once; writes go through the same client/scheduler as scrapes.
  await client.ensureAuthenticated(params.credentials);

  // The employee roster is only needed when some edit reassigns a technician.
  let employees: ResManEmployee[] | null = null;
  if (
    workable.some((row) => row.kind === "edit" && typeof (row.patch ?? {}).technician === "string")
  ) {
    try {
      employees = await fetchEmployees(client, propertyId);
    } catch (fetchError) {
      // Rows needing the roster will fail individually with a clear message;
      // rows that don't need it still flush.
      log(
        `[wo-flush] WARNING: EmployeeList unavailable: ` +
          `${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
      );
    }
  }

  for (const row of workable) {
    const nowIso = now().toISOString();
    const reconcileOnly = row.status === "applying";
    if (!reconcileOnly && !(await claimRow(supabase, row, nowIso))) continue;

    const mirror = await loadUnitId(supabase, row.resman_work_order_id);
    if (!mirror.found) {
      await updateRow(supabase, row.id, {
        status: "failed",
        last_error: "work order is not in the mirror",
        updated_at: nowIso,
      });
      result.failed += 1;
      continue;
    }

    const request = toWriteRequest(row, mirror.unitId, employees);
    if ("error" in request) {
      await updateRow(supabase, row.id, {
        status: "failed",
        last_error: request.error,
        updated_at: nowIso,
      });
      result.failed += 1;
      log(`[wo-flush] ${row.resman_work_order_id} ${row.kind}: failed (${request.error})`);
      continue;
    }

    let outcome: WorkOrderWriteResult;
    try {
      outcome = reconcileOnly
        ? await verifyWrite({ client, request, log, now })
        : await applyWrite({ client, request, log, now });
    } catch (writeError) {
      if (writeError instanceof WorkOrderWriteRefused) {
        // A guard said no. Deterministic — retrying cannot help.
        await updateRow(supabase, row.id, {
          status: "failed",
          last_error: writeError.message,
          updated_at: now().toISOString(),
        });
        result.failed += 1;
        log(`[wo-flush] ${row.resman_work_order_id} ${row.kind}: refused (${writeError.message})`);
        continue;
      }
      if (
        writeError instanceof ResManScrapingError &&
        writeError.kind === "authenticationRequired"
      ) {
        // Session died mid-run: stop the whole run — every later row would
        // hit the same wall (design §5.3, no retry storms). A queued row goes
        // back to queued; a reconcile row must STAY in applying — its POST may
        // have landed, and queued would blind re-POST it.
        await updateRow(supabase, row.id, {
          ...(reconcileOnly ? {} : { status: "queued" }),
          last_error: "session expired mid-run",
          updated_at: now().toISOString(),
        });
        if (reconcileOnly) result.unconfirmed += 1;
        else result.requeued += 1;
        log(`[wo-flush] session expired — stopping run`);
        break;
      }
      const message = writeError instanceof Error ? writeError.message : String(writeError);
      if (reconcileOnly) {
        // The verify read failed — still unconfirmed, still applying. Never
        // back to queued on an inconclusive error: queued means re-POST.
        await updateRow(supabase, row.id, { last_error: message, updated_at: now().toISOString() });
        result.unconfirmed += 1;
        log(`[wo-flush] ${row.resman_work_order_id} ${row.kind}: still unconfirmed (${message})`);
        continue;
      }
      // Transport failure BEFORE the POST landed (harvest GET, etc.) — the
      // writer throws before POSTing, so requeue is safe.
      const exhausted = row.attempts + 1 >= WRITE_MAX_ATTEMPTS;
      await updateRow(supabase, row.id, {
        status: exhausted ? "failed" : "queued",
        last_error: message,
        updated_at: now().toISOString(),
      });
      if (exhausted) result.failed += 1;
      else result.requeued += 1;
      log(
        `[wo-flush] ${row.resman_work_order_id} ${row.kind}: ${exhausted ? "failed" : "requeued"} (${message})`,
      );
      continue;
    }

    const doneIso = now().toISOString();
    if (outcome.ok) {
      await updateRow(supabase, row.id, {
        status: "applied",
        last_error: "",
        applied_at: doneIso,
        updated_at: doneIso,
      });
      result.applied += 1;
      log(
        `[wo-flush] ${row.resman_work_order_id} ${row.kind}: applied` +
          `${outcome.noop ? " (already held every value)" : ""}`,
      );
      continue;
    }
    if (outcome.phase === "posted") {
      // POST went out, confirmation unknown. Leave in `applying`; next run
      // reconciles with a verify-only read. NEVER blind-retry the POST.
      await updateRow(supabase, row.id, { last_error: outcome.detail, updated_at: doneIso });
      result.unconfirmed += 1;
      log(`[wo-flush] ${row.resman_work_order_id} ${row.kind}: unconfirmed (${outcome.detail})`);
      continue;
    }
    // Verified NOT landed — safe to retry until attempts run out.
    const exhausted = row.attempts + (reconcileOnly ? 0 : 1) >= WRITE_MAX_ATTEMPTS;
    await updateRow(supabase, row.id, {
      status: exhausted ? "failed" : "queued",
      last_error: outcome.detail,
      updated_at: doneIso,
    });
    if (exhausted) result.failed += 1;
    else result.requeued += 1;
    log(
      `[wo-flush] ${row.resman_work_order_id} ${row.kind}: ` +
        `${exhausted ? "failed" : "requeued"} (${outcome.detail})`,
    );
  }

  return result;
}
