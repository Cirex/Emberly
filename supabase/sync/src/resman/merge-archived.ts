/**
 * Identity rules for the one-off merge of archived ResMan properties into the
 * property we use now (src/run-merge-archived-properties.ts).
 *
 * Separate from the runner because the runner starts scraping the moment it is
 * imported — this is the part worth testing, so it has to live where a test can
 * reach it without authenticating against ResMan.
 */

export interface LiveUnitIndex {
  /** Every resman_unit_id already in the write property. */
  ids: Set<string>;
  /** unit number → resman_unit_id, for linking work orders to units. */
  idByNumber: Map<string, string>;
}

export interface UnitNumberCollision {
  number: string;
  archivedId: string;
  liveId: string;
}

export type UnitVerdict =
  | { kind: "alreadyOurs" }
  | { kind: "insert"; collision?: UnitNumberCollision };

/**
 * Decide what to do with one mapped archived unit.
 *
 * `alreadyOurs` means the id is already in the write property, so the live row
 * wins and the archived snapshot is discarded — the archived reports are frozen,
 * and upserting one over a current row would push stale occupancy and tenant
 * names into the apps.
 *
 * A `collision` means the unit NUMBER is taken by a DIFFERENT id. The row is
 * still an insert — nothing else could be correct without knowing which record
 * ResMan considers canonical — but it is reported, because it is the exact shape
 * of a duplicate unit: two rows, one address, doubled in occupancy counts.
 */
export function classifyUnitRow(
  row: { resman_unit_id: string; number: string },
  live: LiveUnitIndex,
): UnitVerdict {
  const unitId = row.resman_unit_id;
  if (live.ids.has(unitId)) return { kind: "alreadyOurs" };

  const number = (row.number ?? "").trim();
  const liveId = number.length > 0 ? live.idByNumber.get(number) : undefined;
  if (liveId && liveId !== unitId) {
    return { kind: "insert", collision: { number, archivedId: unitId, liveId } };
  }
  return { kind: "insert" };
}
