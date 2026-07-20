/**
 * Day/night for the property map's night palette. The iOS app computed
 * sunrise/sunset via CoreLocation (SolarTimeObserver); this is a simple
 * hour-based approximation — swap in expo-location + a solar calc later for
 * accuracy.
 */
export function isNight(date: Date = new Date()): boolean {
  const hour = date.getHours();
  return hour < 6 || hour >= 19;
}
