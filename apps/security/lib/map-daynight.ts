/**
 * Day/night for camera-cone coloring. The iOS app computed sunrise/sunset via
 * CoreLocation (SolarTimeObserver); this is a simple hour-based approximation —
 * swap in expo-location + a solar calc later for accuracy.
 */
export function isNight(date: Date = new Date()): boolean {
  const hour = date.getHours();
  return hour < 6 || hour >= 19;
}

/** Camera coverage-cone fill by time of day (blue = day, amber = night). */
export function coneColor(night: boolean, active: boolean): string {
  if (!active) return "rgba(112,120,143,0.14)";
  return night ? "rgba(255,153,26,0.30)" : "rgba(51,153,255,0.24)";
}
