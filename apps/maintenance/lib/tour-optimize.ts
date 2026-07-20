/**
 * Tour route models + the nearest-neighbor route optimizer.
 *
 * Port of TourRoute.optimized(using:) from KrakenPropertyMap (TourRoute.swift),
 * kept free of React Native imports so bun tests can exercise the algorithm
 * directly.
 */

/** One stop on the active tour (a unit on the property map). */
export interface TourStop {
  id: string;
  unitNumber: string;
  note: string;
  isDone: boolean;
}

/** A finished tour snapshotted into history. */
export interface CompletedTour {
  id: string;
  /** Epoch milliseconds. */
  completedAt: number;
  stops: TourStop[];
}

export interface TourPoint {
  x: number;
  y: number;
}

/**
 * Reorders stops by a nearest-neighbor walk over unit centroids, starting
 * from the current first stop and comparing squared distances. Stops whose
 * unit has no known centroid keep their relative order and go to the end —
 * exactly the Swift semantics:
 * - 2 or fewer stops: unchanged.
 * - fewer than 2 locatable stops: unchanged.
 */
export function optimizeStops(
  stops: TourStop[],
  centers: ReadonlyMap<string, TourPoint>,
): TourStop[] {
  if (stops.length <= 2) return stops;
  const known = stops.filter((s) => centers.has(s.unitNumber));
  const unknown = stops.filter((s) => !centers.has(s.unitNumber));
  if (known.length <= 1) return stops;

  const center = (s: TourStop): TourPoint => centers.get(s.unitNumber)!;
  const dist2 = (a: TourPoint, b: TourPoint): number => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  };

  const remaining = [...known];
  const ordered: TourStop[] = [];
  let current = remaining.shift()!;
  ordered.push(current);

  while (remaining.length > 0) {
    const cc = center(current);
    let nearest = 0;
    for (let i = 1; i < remaining.length; i += 1) {
      if (dist2(center(remaining[i]), cc) < dist2(center(remaining[nearest]), cc)) nearest = i;
    }
    current = remaining.splice(nearest, 1)[0];
    ordered.push(current);
  }
  return [...ordered, ...unknown];
}
