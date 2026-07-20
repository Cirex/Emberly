/**
 * Shared pill classes for health/severity badges across the admin screens.
 */
export function healthPillClass(severity?: string): string {
  if (severity === "ok") return "pill-ok";
  if (severity === "critical") return "pill-crit";
  if (severity === "warning") return "pill-warn";
  return "pill-neutral";
}
