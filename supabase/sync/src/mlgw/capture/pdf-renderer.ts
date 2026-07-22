/**
 * HTML → PDF rendering for MLGW bill captures.
 *
 * The document handed to `render` is already self-contained (see
 * `html-inliner.ts`), so the browser needs NO network and NO cookies: we call
 * `page.setContent(html, { waitUntil: "load" })` and print. Every outbound
 * request is aborted at the route level, which makes that guarantee structural
 * rather than merely intended.
 *
 * Lifecycle: ONE browser per sync run. Launching per bill would add seconds of
 * process startup to each of thousands of bills; the browser is launched lazily
 * on the first render and closed by the caller's `finally`.
 *
 * Robustness contract (the whole reason this returns `null` instead of throwing):
 * if Chromium is missing, fails to launch, or a render throws, `render` logs ONCE
 * and returns `null` forever after. The caller then falls back to the legacy text
 * transcript, so a missing renderer degrades quality — it never fails a sync and
 * never loses a bill.
 */

import type { Browser } from "playwright-core";
import { chromiumPathDiagnostic, resolveChromiumExecutablePath } from "./chromium-path";

/** Renders self-contained HTML to PDF bytes, or `null` when unavailable. */
export interface BillPdfRenderer {
  /** MUST NOT throw. `null` means "render unavailable — use the fallback". */
  render(html: string): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export interface ChromiumRendererOptions {
  log?: (message: string) => void;
  /** Per-page setContent/print timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Override the resolved executable (tests / unusual installs). */
  executablePath?: string | null;
}

/** A renderer that is always unavailable — the caller falls back. Used in tests. */
export class UnavailableBillPdfRenderer implements BillPdfRenderer {
  render(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const LAUNCH_ARGS = [
  // Containers commonly run without the kernel features the sandbox needs, and
  // /dev/shm is tiny in Docker's default config.
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
];

export class ChromiumBillPdfRenderer implements BillPdfRenderer {
  private browser: Browser | null = null;
  private launch: Promise<Browser | null> | null = null;
  private unavailable = false;
  private readonly log: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly executablePath: string | null;

  constructor(options: ChromiumRendererOptions = {}) {
    this.log = options.log ?? ((message) => console.warn(message));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.executablePath =
      options.executablePath === undefined ? resolveChromiumExecutablePath() : options.executablePath;
  }

  /** Launch (at most once). `null` means the renderer is permanently unavailable. */
  private browserOnce(): Promise<Browser | null> {
    if (this.launch !== null) return this.launch;
    this.launch = (async (): Promise<Browser | null> => {
      if (this.executablePath === null) {
        this.markUnavailable(`[mlgw-bills] bill PDF rendering disabled: ${chromiumPathDiagnostic()}`);
        return null;
      }
      try {
        const { chromium } = await import("playwright-core");
        const browser = await chromium.launch({
          executablePath: this.executablePath,
          headless: true,
          args: LAUNCH_ARGS,
        });
        this.browser = browser;
        this.log(`[mlgw-bills] rendering bill captures with Chromium at ${this.executablePath}`);
        return browser;
      } catch (error) {
        this.markUnavailable(
          `[mlgw-bills] bill PDF rendering disabled: could not launch Chromium at ${this.executablePath}: ${describeError(error)}`,
        );
        return null;
      }
    })();
    return this.launch;
  }

  private markUnavailable(message: string): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.log(message);
  }

  async render(html: string): Promise<Uint8Array | null> {
    if (this.unavailable) return null;
    const browser = await this.browserOnce();
    if (browser === null) return null;

    let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
    try {
      context = await browser.newContext({ javaScriptEnabled: false });
      // Structural offline guarantee: only inline (`data:`) and `about:` URLs
      // may resolve. A stray external reference fails fast instead of hanging
      // the render on a network round-trip the browser has no session for.
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("data:") || url.startsWith("about:")) void route.continue();
        else void route.abort();
      });
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load", timeout: this.timeoutMs });
      const pdf = await page.pdf({
        format: "Letter",
        printBackground: true,
        margin: { top: "0.4in", right: "0.4in", bottom: "0.4in", left: "0.4in" },
      });
      return new Uint8Array(pdf);
    } catch (error) {
      // One clear log line, then keep going: an individual bad page must not
      // take the renderer (or the sync) down.
      this.log(`[mlgw-bills] bill PDF render failed, falling back to text capture: ${describeError(error)}`);
      return null;
    } finally {
      if (context !== null) await context.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.launch = null;
    if (browser === null) return;
    await browser.close().catch(() => {});
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The renderer used by the sync run. Always succeeds — availability is decided lazily. */
export function createBillPdfRenderer(options: ChromiumRendererOptions = {}): BillPdfRenderer {
  return new ChromiumBillPdfRenderer(options);
}
