import * as Sentry from "@sentry/nextjs";

/**
 * Server + Edge runtime Sentry init.
 *
 * Fully env-guarded: if SENTRY_DSN (server) is unset, Sentry is disabled and
 * this is a no-op. The app runs normally with or without a DSN configured.
 */
export async function register() {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;

  const common = {
    dsn,
    enabled: true,
    environment: process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
  };

  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init(common);
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init(common);
  }
}

export const onRequestError = Sentry.captureRequestError;
