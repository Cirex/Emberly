import PostHog from "posthog-react-native";

/**
 * PostHog product analytics for the security (guard) app.
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
 */
export const posthog: PostHog | null = apiKey ? new PostHog(apiKey, { host }) : null;

/**
 * Known analytics events. Kept as a union so call sites are typo-checked while
 * still allowing ad-hoc event names during development.
 */
export type AnalyticsEvent =
  "scanner_configured" | "pass_scanned" | "entry_photo_captured" | (string & {});

/** A JSON-serializable value — mirrors what PostHog accepts for properties. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Event/user properties. JSON-serializable, matching PostHog's expectations. */
export type AnalyticsProperties = Record<string, JsonValue>;

/** Capture a product event. No-op when analytics is disabled. */
export function capture(event: AnalyticsEvent, properties?: AnalyticsProperties): void {
  posthog?.capture(event, properties);
}

/** Associate subsequent events with a user. No-op when analytics is disabled. */
export function identify(distinctId: string, properties?: AnalyticsProperties): void {
  posthog?.identify(distinctId, properties);
}

/** Clear the current identity (e.g. on sign-out). No-op when analytics is disabled. */
export function resetAnalytics(): void {
  posthog?.reset();
}
