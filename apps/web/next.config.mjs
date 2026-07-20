import { fileURLToPath } from "node:url";
import { withSentryConfig } from "@sentry/nextjs";

// Monorepo root (apps/web -> ../.. == repo root). The @emberly/core workspace
// dependency is symlinked into the hoisted root node_modules from packages/core.
// Both Turbopack's workspace root and Next's output-file tracing root must point
// at the monorepo root so the workspace package resolves during dev and is
// copied into the standalone build.
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output bundles a minimal server (.next/standalone/.../server.js)
  // plus traced node_modules for a small, self-contained Docker runtime image.
  output: "standalone",
  // Ensure the traced standalone output includes ../emberly-shared.
  outputFileTracingRoot: workspaceRoot,
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.0.22"],
  serverExternalPackages: ["otpauth"],
  turbopack: {
    root: workspaceRoot,
  },
};

// Source-map upload is gated entirely on SENTRY_AUTH_TOKEN. Without it,
// withSentryConfig is a no-op wrapper (no upload attempts, build succeeds).
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim();

const sentryBuildOptions = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: sentryAuthToken,
  // Only upload source maps when an auth token is present.
  sourcemaps: {
    disable: !sentryAuthToken,
  },
  // Keep build output quiet; only warn in CI-style logs.
  silent: !process.env.CI,
  // Avoid touching telemetry from build.
  telemetry: false,
  // Tree-shake Sentry logger statements in production bundles.
  disableLogger: true,
};

export default withSentryConfig(nextConfig, sentryBuildOptions);
