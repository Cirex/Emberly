import * as Sentry from "@sentry/nextjs";

/**
 * Browser (client) runtime Sentry init.
 *
 * Fully env-guarded: if NEXT_PUBLIC_SENTRY_DSN is unset, Sentry is disabled and
 * this module is a no-op. The app runs normally with or without a DSN.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();

if (dsn) {
  Sentry.init({
    dsn,
    enabled: true,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV,
    tracesSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0",
    ),
  });
}

// Required by Next.js App Router for navigation instrumentation. Safe no-op
// when Sentry was not initialized above.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
