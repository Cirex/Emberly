/**
 * Which work-order prose to translate, and in what order.
 *
 * A property with thousands of work orders has far more prose than one
 * translation session can chew through quickly, and every string costs the same
 * whether or not anyone will read it today. Ordering is the whole feature: the
 * chunks run in sequence, so whatever comes first is what a tech sees translated
 * first. Everything else still lands — just later, in the background.
 */

/** The prose fields carried by a work order, in the order they're read. */
export interface TranslatableWorkOrder {
  /** Matches My Day's stop ids — ParsedWorkOrder.id is this field. */
  resman_work_order_id: string;
  title?: string;
  notes?: string;
  completion_notes?: string;
}

function proseOf(order: TranslatableWorkOrder): string[] {
  const out: string[] = [];
  if (order.title) out.push(order.title);
  if (order.notes) out.push(order.notes);
  if (order.completion_notes) out.push(order.completion_notes);
  return out;
}

/**
 * Every work order's prose, with `priorityIds` first and in the order given.
 *
 * The priority list is the technician's visible work — today's stops, the open
 * detail screen. Those ids are translated before the long tail, so the screens
 * actually in front of someone fill in within a chunk or two rather than after
 * the whole property has been processed.
 *
 * Ids in `priorityIds` that no longer exist are skipped rather than treated as
 * an error: a stop can outlive the work order that created it.
 */
export function orderedTranslationSources(
  orders: TranslatableWorkOrder[],
  priorityIds: readonly string[] = [],
): string[] {
  if (priorityIds.length === 0) return orders.flatMap(proseOf);

  const byId = new Map(orders.map((o) => [o.resman_work_order_id, o]));
  const taken = new Set<string>();
  const first: string[] = [];

  for (const id of priorityIds) {
    const order = byId.get(id);
    if (!order || taken.has(id)) continue;
    taken.add(id);
    first.push(...proseOf(order));
  }

  const rest = orders.filter((o) => !taken.has(o.resman_work_order_id)).flatMap(proseOf);
  return [...first, ...rest];
}
