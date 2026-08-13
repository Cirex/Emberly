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

// MARK: - Lease identity across the property merge

/**
 * One resident name, flattened for comparison.
 *
 * Names are the ONLY resident identity that survived the merge. ResMan re-minted
 * `personId` along with everything else — Mario Shannon is
 * 90ed6fde… on the archived record and fb1c4254… on the live one, zero overlap —
 * so matching on the id finds nothing and imports everything.
 */
export function normalizeName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The resident half of a lease key: distinct normalized names, sorted.
 *
 * A SET, not a list. One archived lease listed "Paris Hurt" twice under two
 * different person ids, which a positional or count-sensitive key would treat as
 * a different household from the same lease seen elsewhere.
 */
export function residentKey(names: ReadonlyArray<string | null | undefined>): string {
  const distinct = [...new Set(names.map(normalizeName).filter((n) => n.length > 0))].sort();
  return distinct.join("+");
}

/** `unit|start|end` — the part of the key that never depends on resident data. */
export function leaseTermKey(unitNumber: string, start: string | null, end: string | null): string {
  return `${(unitNumber ?? "").trim()}|${start ?? ""}|${end ?? ""}`;
}

export interface LiveLeaseIndex {
  /** `unit|start|end|residents` → live lease id. The precise match. */
  byTermAndResidents: Map<string, string>;
  /** `unit|start|end` → live lease ids. The fallback when names are unavailable. */
  byTerm: Map<string, string[]>;
}

export type LeaseVerdict =
  /** A live lease covers this term and household. The live row wins; drop the archived one. */
  | { kind: "skip"; reason: "resident-and-term" | "term-only"; liveLeaseId: string }
  /** Nothing live covers it — genuinely old, safe to bring over as history. */
  | { kind: "import" }
  /** No live unit carries this number, so there is nothing to attach it to. */
  | { kind: "noLiveUnit" }
  /** No term to key on, and the fallback cannot be trusted without one. */
  | { kind: "unkeyable" };

/**
 * Decide whether an archived lease already exists in the live property.
 *
 * The live property is authoritative. Its record reflects the current state of
 * the door in ResMan, whatever status it carries, so a lease that exists on both
 * sides is not imported — the live row stands and the archived copy is dropped.
 *
 * TWO TIERS, both erring toward skipping. Term plus household is the precise
 * match. Term alone is the fallback, because past and pending leases come back
 * from the lease-history table as SKELETONS with no resident identity at all —
 * an archived skeleton would never match by name and would import as a duplicate
 * of a live lease it plainly is. Where the term alone matches, that is treated as
 * existing. The two are counted separately so the weaker tier stays visible.
 *
 * A term-only match against SEVERAL live leases is still a skip. 27 such
 * collisions exist within the live property alone, nearly all `Cancelled +
 * Current` — one application cancelled and re-signed for the same dates. Which
 * of the two it pairs with does not matter here, because nothing is being
 * attached to it; the lease is being dropped either way.
 */
export function classifyArchivedLease(
  lease: {
    unitNumber: string;
    startDate: string | null;
    endDate: string | null;
    residentNames: ReadonlyArray<string | null | undefined>;
  },
  live: LiveLeaseIndex,
  liveUnitExists: boolean,
): LeaseVerdict {
  if (!liveUnitExists) return { kind: "noLiveUnit" };

  const term = leaseTermKey(lease.unitNumber, lease.startDate, lease.endDate);
  if (!lease.startDate && !lease.endDate) return { kind: "unkeyable" };

  const residents = residentKey(lease.residentNames);
  if (residents.length > 0) {
    const exact = live.byTermAndResidents.get(`${term}|${residents}`);
    if (exact) return { kind: "skip", reason: "resident-and-term", liveLeaseId: exact };
  }

  const sameTerm = live.byTerm.get(term);
  if (sameTerm && sameTerm.length > 0) {
    return { kind: "skip", reason: "term-only", liveLeaseId: sameTerm[0] };
  }

  return { kind: "import" };
}
