import {
  RESMAN_WORK_ORDER_PRIORITIES,
  RESMAN_WORK_ORDER_STATUSES,
} from "@emberly/core";

/**
 * Localized labels for ResMan's fixed vocabularies (status, priority).
 *
 * These are NOT machine-translated. `useTranslated` exists for free prose a
 * human wrote — a work-order description, a technician's note — where the
 * content is unpredictable. Status and priority are a closed set of four to six
 * values that appear on nearly every row, so they get real, reviewed Spanish
 * from the catalog. Sending them through the translator instead would spend a
 * cache entry per value and still risk "In Progress" coming back as something a
 * technician has to decode.
 *
 * FALLS BACK TO THE RAW VALUE. The mirror's CHECK constraint defines today's
 * set, but ResMan can widen it; an unmapped value must render as itself rather
 * than blank or as a key. That matches how the wire types are deliberately
 * string-tolerant (lib/api/work-orders.ts).
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The copy itself, kept HERE rather than inline in lib/i18n so it sits beside
 * the mapping it belongs to and can be tested without importing i18next (which
 * pulls in react-native). lib/i18n composes this into its `resman` namespace.
 */
export interface ResmanLabelSet {
  status: Record<string, string>;
  priority: Record<string, string>;
}

export const RESMAN_LABELS: Record<"en" | "es", ResmanLabelSet> = {
  en: {
    status: {
      notStarted: "Not started",
      scheduled: "Scheduled",
      inProgress: "In progress",
      completed: "Completed",
      closed: "Closed",
      canceled: "Canceled",
    },
    priority: { emergency: "Emergency", high: "High", normal: "Normal", low: "Low" },
  },
  es: {
    status: {
      notStarted: "Sin iniciar",
      scheduled: "Programada",
      inProgress: "En curso",
      completed: "Completada",
      closed: "Cerrada",
      canceled: "Cancelada",
    },
    priority: { emergency: "Emergencia", high: "Alta", normal: "Normal", low: "Baja" },
  },
};

/** ResMan value → i18n key stem. Kept explicit so a new value is a visible gap. */
const STATUS_KEYS: Record<string, string> = {
  "Not Started": "notStarted",
  Scheduled: "scheduled",
  "In Progress": "inProgress",
  Completed: "completed",
  Closed: "closed",
  Canceled: "canceled",
  // ResMan's own reports have used the British spelling in places; both map to
  // the same label rather than one of them falling through to raw English.
  Cancelled: "canceled",
};

const PRIORITY_KEYS: Record<string, string> = {
  Emergency: "emergency",
  High: "high",
  Normal: "normal",
  Low: "low",
};

function labelFrom(
  t: Translate,
  keys: Record<string, string>,
  namespace: string,
  value: string,
): string {
  const stem = keys[value.trim()];
  if (!stem) return value;
  const key = `${namespace}.${stem}`;
  const translated = t(key);
  // i18next echoes the key back when it is missing; never show a key to a tech.
  return translated === key ? value : translated;
}

/** Localized work-order status, or the raw value when ResMan widened the set. */
export function statusLabel(t: Translate, status: string): string {
  return labelFrom(t, STATUS_KEYS, "resman.status", status);
}

/** Localized work-order priority, or the raw value when unmapped. */
export function priorityLabel(t: Translate, priority: string): string {
  return labelFrom(t, PRIORITY_KEYS, "resman.priority", priority);
}

/**
 * Every value the mirror's CHECK constraint allows must have a mapping — a new
 * ResMan status shipping as raw English is exactly the gap this catches.
 */
export const MAPPED_STATUSES = RESMAN_WORK_ORDER_STATUSES;
export const MAPPED_PRIORITIES = RESMAN_WORK_ORDER_PRIORITIES;
export { STATUS_KEYS, PRIORITY_KEYS };
