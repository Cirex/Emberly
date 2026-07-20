import * as Sentry from "@sentry/react-native";

/**
 * Sentry crash/error reporting for the maintenance app.
 *
 * This is one of three SEPARATE Sentry projects (web, resident, and the
 * property-manager surface each report to their own DSN). The DSN comes from
 * `EXPO_PUBLIC_SENTRY_DSN`.
 *
 * INERT BY DEFAULT: when the DSN env var is unset, `Sentry.init` is skipped
 * entirely and every Sentry call becomes a harmless no-op, so the app runs
 * normally with no accounts or keys configured.
 */
const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

/** True only when a DSN is configured via env. */
export const sentryEnabled = Boolean(dsn);

/**
 * Performance tracing sample rate. Defaults to a conservative 0.2 (20%) and is
 * overridable via `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`. Only takes effect
 * when a DSN is present. Clamped to [0, 1].
 */
function resolveTracesSampleRate(): number {
  const raw = process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE;
  const parsed = raw === undefined ? 0.2 : Number(raw);
  if (!Number.isFinite(parsed)) return 0.2;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * Initialize Sentry. Safe to call unconditionally: it returns immediately (and
 * initializes nothing) when no DSN is configured.
 */
export function initSentry(): void {
  if (!dsn) return; // No DSN => stay completely inert.

  try {
    Sentry.init({
      dsn,
      enabled: sentryEnabled,
      // Native crash + JS error capture are on by default in @sentry/react-native.
      tracesSampleRate: resolveTracesSampleRate(),
      // Privacy: this app handles resident PII, so never attach it automatically.
      sendDefaultPii: false,
    });
  } catch (error) {
    // Crash reporting failing to start must never itself crash launch.
    console.warn("[sentry] init failed; crash reporting disabled:", error);
  }
}

// Initialize on import so crash reporting is armed as early as possible — before
// the rest of the app's modules (and their native side-effects) load. This module
// is imported first in app/_layout.tsx for exactly that reason. No-op without a DSN.
initSentry();

export { Sentry };
