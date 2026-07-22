/**
 * MLGW bill-capture layer: turn an authenticated bill page into a
 * self-contained HTML archive plus a real, bill-shaped PDF.
 *
 *   html-inliner   — fetch + inline every referenced asset (pure-ish, testable)
 *   asset-fetcher  — the authenticated `AssetFetch` backed by MLGWHTTPClient
 *   chromium-path  — locate a system Chromium for playwright-core
 *   pdf-renderer   — one browser per sync run; `null` (never throws) on failure
 */

export * from "./html-inliner";
export * from "./asset-fetcher";
export * from "./chromium-path";
export * from "./pdf-renderer";
