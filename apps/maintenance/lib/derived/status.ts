/**
 * Status/classification color + rank maps. Ports AppStatusTint.workOrderStatus
 * (Swift) onto the security-app token palette; string-tolerant with a neutral
 * fallback so a widened upstream enum never crashes a row.
 */

/** Security design-token hexes (tailwind.config.js). */
export const TINT = {
  ready: "#33A666",
  closed: "#3D9461",
  blocked: "#D1382E",
  warning: "#E38736",
  info: "#458ADB",
  accentBlue: "#3D87E0",
  review: "#7A6BC7",
  muted: "#70788F",
  navy: "#091B54",
} as const;

/** AppStatusTint.workOrderStatus: Completed→affirmative, Closed→muted green,
 *  Cancelled/Not Started→red, in-flight→orange; Scheduled reads as info blue
 *  (the synced enum has it where Swift had Submitted/On Hold). */
export function workOrderStatusColor(status: string): string {
  switch (status) {
    case "Completed":
      return TINT.ready;
    case "Closed":
      return TINT.closed;
    case "Canceled":
    case "Cancelled":
    case "Not Started":
      return TINT.blocked;
    case "Scheduled":
      return TINT.info;
    case "In Progress":
    case "Submitted":
    case "On Hold":
    case "Open":
      return TINT.warning;
    default:
      return TINT.muted;
  }
}

/** Stable rank for status sorting (ascending = workflow order). */
const STATUS_RANK: Record<string, number> = {
  "Not Started": 0,
  Scheduled: 1,
  Submitted: 1,
  "In Progress": 2,
  "On Hold": 3,
  Completed: 4,
  Closed: 5,
  Canceled: 6,
  Cancelled: 6,
};

export const CLASSIFICATION_COLOR: Record<string, string> = {
  Ruby: "#9C101F",
  Diamond: "#388FC7",
  Legacy: "#9E805C",
  // ResMan stores this one upper-case ("LUX"). It was keyed "Lux" here, so every
  // LUX unit fell through to the muted default and looked unclassified.
  LUX: "#C79433",
};

/** Case-insensitive: ResMan's casing is not guaranteed to stay put. */
export function classificationColor(classification: string): string {
  const direct = CLASSIFICATION_COLOR[classification];
  if (direct) return direct;
  const key = Object.keys(CLASSIFICATION_COLOR).find(
    (k) => k.toLowerCase() === classification.trim().toLowerCase(),
  );
  return key ? CLASSIFICATION_COLOR[key] : TINT.muted;
}
