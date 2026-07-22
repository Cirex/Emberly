/**
 * System-Chromium discovery for the bill-capture renderer.
 *
 * The worker depends on `playwright-core` (NOT `playwright`) so that no browser
 * is downloaded at install time — the lockfile stays small and `bun install`
 * stays offline-friendly. That means Playwright has no bundled browser to point
 * at, so the executable must be supplied explicitly via `executablePath`.
 *
 * Resolution order:
 *   1. `CHROMIUM_PATH` (what the Dockerfile sets; the only thing to configure in
 *      production).
 *   2. The distro/Homebrew/Chrome locations below, so a developer laptop works
 *      with no configuration at all.
 *
 * Returns `null` when nothing is found — the caller then logs once and falls
 * back to the text-transcript PDF. A missing browser must never fail a sync.
 */

import { existsSync } from "node:fs";

/** Non-macOS (container/Linux) candidates, in preference order. */
export const LINUX_CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/lib/chromium/chromium",
  "/snap/bin/chromium",
];

/** macOS (developer laptop) candidates, in preference order. */
export const DARWIN_CHROMIUM_CANDIDATES = [
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/opt/homebrew/bin/chromium",
  "/usr/local/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

export interface ChromiumPathOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Injected for tests; defaults to `fs.existsSync`. */
  exists?: (path: string) => boolean;
}

/** The candidate list for a platform (exported for tests/diagnostics). */
export function chromiumCandidates(platform: string): string[] {
  return platform === "darwin" ? DARWIN_CHROMIUM_CANDIDATES : LINUX_CHROMIUM_CANDIDATES;
}

/**
 * The first Chromium-family executable that exists, or `null`.
 *
 * `CHROMIUM_PATH` wins when it points at something real. When it is set but
 * missing, the fallbacks are still tried (a stale env var should not defeat a
 * perfectly good system browser) — `chromiumPathDiagnostic` reports that case.
 */
export function resolveChromiumExecutablePath(options: ChromiumPathOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;

  const configured = env["CHROMIUM_PATH"]?.trim();
  if (configured !== undefined && configured.length > 0 && exists(configured)) {
    return configured;
  }
  for (const candidate of chromiumCandidates(platform)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** A human-readable explanation for the log when resolution is interesting. */
export function chromiumPathDiagnostic(options: ChromiumPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const configured = env["CHROMIUM_PATH"]?.trim();

  if (configured !== undefined && configured.length > 0 && !exists(configured)) {
    return `CHROMIUM_PATH=${configured} does not exist; tried ${chromiumCandidates(platform).join(", ")}`;
  }
  const resolved = resolveChromiumExecutablePath(options);
  if (resolved === null) {
    return `no Chromium found (set CHROMIUM_PATH; tried ${chromiumCandidates(platform).join(", ")})`;
  }
  return `using Chromium at ${resolved}`;
}
