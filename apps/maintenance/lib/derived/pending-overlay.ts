import { sanitizeDescription } from "@emberly/core";
import type { WorkOrder } from "@/lib/api/work-orders";
import type { PendingClose } from "@/lib/stores/pending-closes";
import type { PendingEdit } from "@/lib/stores/pending-edits";

/**
 * The device's own writes, laid over the server mirror — for EVERY screen.
 *
 * A write goes device → ResMan directly and is verified there, but the mirror
 * the app reads only learns of it on the next server scrape, minutes later.
 * The overlay used to be applied by the detail screen alone, so a tech who
 * reassigned a work order saw it reassigned on that one screen and then watched
 * it snap back to the old technician on the board, in My Day and in every
 * filter until the scrape landed. A close did the same on the Open board.
 *
 * This applies both queues to the raw rows BEFORE parsing, so the whole derived
 * engine — boards, My Day, filters, analytics, the map — sees one consistent
 * world. The stores still retire entries once the mirror absorbs them; at that
 * point the overlay is a no-op and the base row stands on its own.
 *
 * Writes ResMan REFUSED are not overlaid. Nothing landed, so painting them as
 * real would be the same lie the outbox refuses to tell; the outbox and the
 * detail screen's field markers carry them instead.
 */

/** Only the fields a row's overlay depends on — never ack state or errors. */
interface RowOverlay {
  edit?: PendingEdit["patch"];
  close?: { note: string; completedAt: number };
}

/** A local calendar date as the mirror's `date` columns spell it. */
export function localDateString(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function overlayRow(row: WorkOrder, o: RowOverlay): WorkOrder {
  const next: WorkOrder = { ...row };
  const edit = o.edit;
  if (edit) {
    // The patch carries the DISPLAY form; the mirror stores "" for nobody.
    if (edit.technician !== undefined) {
      next.technician = edit.technician === "Unassigned" ? "" : edit.technician;
    }
    // What ResMan will actually hold, not the raw keystrokes.
    if (edit.description !== undefined) next.notes = sanitizeDescription(edit.description);
    if (edit.completionNotes !== undefined) next.completion_notes = edit.completionNotes;
    if (edit.scheduledAt !== undefined) {
      const ms = edit.scheduledAt === null ? NaN : Date.parse(edit.scheduledAt);
      // Date-only, like the mirror, so day bucketing matches what will land.
      next.date_scheduled = Number.isNaN(ms) ? null : localDateString(ms);
    }
  }
  if (o.close) {
    next.status = "Completed";
    next.date_completed = localDateString(o.close.completedAt);
    // The close's note is what ResMan's completion notes end up holding.
    if (o.close.note) next.completion_notes = o.close.note;
  }
  return next;
}

function overlaysOf(
  edits: Readonly<Record<string, PendingEdit>>,
  closes: Readonly<Record<string, PendingClose>>,
): Map<string, RowOverlay> {
  const byId = new Map<string, RowOverlay>();
  for (const e of Object.values(edits)) {
    if (e.blockedReason !== undefined) continue;
    byId.set(e.workOrderId, { edit: e.patch });
  }
  for (const c of Object.values(closes)) {
    if (c.blockedReason !== undefined) continue;
    const cur = byId.get(c.workOrderId) ?? {};
    byId.set(c.workOrderId, {
      ...cur,
      close: { note: c.note, completedAt: c.completedAt ?? c.queuedAt },
    });
  }
  return byId;
}

/**
 * Stable key over exactly what the overlay depends on. An ack, a retry count or
 * a recorded error changes the stores but not a single overlaid value, and must
 * not rebuild the mirror.
 */
export function overlaySignature(
  edits: Readonly<Record<string, PendingEdit>>,
  closes: Readonly<Record<string, PendingClose>>,
): string {
  const entries = [...overlaysOf(edits, closes)].sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}

/**
 * Per-row memo: the same base row under the same overlay yields the SAME
 * object, so the parser's per-row caches keep hitting and only rows that
 * actually changed are re-parsed.
 */
const rowMemo = new WeakMap<WorkOrder, { key: string; out: WorkOrder }>();

/** `rows` with the pending writes applied. Returns `rows` itself when none do. */
export function applyPendingOverlay(
  rows: readonly WorkOrder[],
  edits: Readonly<Record<string, PendingEdit>>,
  closes: Readonly<Record<string, PendingClose>>,
): readonly WorkOrder[] {
  const byId = overlaysOf(edits, closes);
  if (byId.size === 0) return rows;
  let changed = false;
  const out = rows.map((row) => {
    const o = byId.get(row.resman_work_order_id);
    if (!o) return row;
    changed = true;
    const key = JSON.stringify(o);
    const hit = rowMemo.get(row);
    if (hit && hit.key === key) return hit.out;
    const next = overlayRow(row, o);
    rowMemo.set(row, { key, out: next });
    return next;
  });
  return changed ? out : rows;
}
