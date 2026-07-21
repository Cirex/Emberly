import PostHog from "posthog-react-native";

/**
 * PostHog product analytics for the manager app.
 *
 * Key comes from `EXPO_PUBLIC_POSTHOG_KEY`; host from `EXPO_PUBLIC_POSTHOG_HOST`
 * (defaults to PostHog US cloud). The app is wrapped in `PostHogProvider` at the
 * root (see app/_layout.tsx) using the `posthog` client exported here.
 *
 * INERT BY DEFAULT: when the key env var is unset, no client is created and the
 * `capture`/`identify`/`resetAnalytics` helpers become no-ops. Screens should
 * import these helpers rather than touching the SDK directly, so analytics can
 * stay a single, env-guarded seam.
 */
const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
const host = process.env.EXPO_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

/** True only when a PostHog key is configured via env. */
export const analyticsEnabled = Boolean(apiKey);

/**
 * The PostHog client, or `null` when analytics is disabled. Passed to
 * `PostHogProvider` at the root; also used by the helpers below.
 *
 * Construction is wrapped so a failure in the SDK's init (e.g. a native storage
 * backend problem) can NEVER take down app launch — this module is imported at
 * the top of the root layout, before Sentry is armed, so an unguarded throw here
 * would be an un-reported crash-on-open. On failure we stay inert (null).
 */
function createPosthogClient(): PostHog | null {
  if (!apiKey) return null;
  try {
    return new PostHog(apiKey, { host });
  } catch (error) {
    console.warn("[analytics] PostHog init failed; analytics disabled:", error);
    return null;
  }
}

export const posthog: PostHog | null = createPosthogClient();

/**
 * Known analytics events. Kept as a union so call sites are typo-checked while
 * still allowing ad-hoc event names during development.
 */
export type AnalyticsEvent = "signed_in" | "signed_out" | "language_changed" | (string & {});

/** A JSON-serializable value — mirrors what PostHog accepts for properties. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Event/user properties. JSON-serializable, matching PostHog's expectations. */
export type AnalyticsProperties = Record<string, JsonValue>;

/** Capture a product event. No-op when analytics is disabled. */
export function capture(event: AnalyticsEvent, properties?: AnalyticsProperties): void {
  posthog?.capture(event, properties);
}

// Transition-into-failure latch for `sync_failed`: during a long outage the
// 60s tick would otherwise fire the event every minute per store. Only the
// first failure after a success reports; a successful sync re-arms its store.
const failedSyncStores = new Set<string>();

/** Report a background refresh/sync failure, once per outage per store. */
export function reportSyncFailed(store: string): void {
  if (failedSyncStores.has(store)) return;
  failedSyncStores.add(store);
  capture("sync_failed", { store });
}

/** Re-arm the failure latch for a store after a successful refresh/sync. */
export function reportSyncSucceeded(store: string): void {
  failedSyncStores.delete(store);
}

/** Associate subsequent events with a user. No-op when analytics is disabled. */
export function identify(distinctId: string, properties?: AnalyticsProperties): void {
  posthog?.identify(distinctId, properties);
}

/** Clear the current identity (e.g. on sign-out). No-op when analytics is disabled. */
export function resetAnalytics(): void {
  posthog?.reset();
}
