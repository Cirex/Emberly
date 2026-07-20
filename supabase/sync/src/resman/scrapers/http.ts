/**
 * `ResManScrapeHttp` — the thin GET wrapper the unit-detail scrapers issue every
 * request through. Port of the private `ResManHTTPHelper` in
 * KrakenCore/Services/ResMan/ResManUnitDetailScraper.swift.
 *
 * It sits on top of the shared `ResManClient.data(...)` choke point (which owns
 * auth, the cookie jar, and the rate-limited scheduler), so it adds only:
 *   - relative-path resolution against `client.configuration.consumerStartUrl`;
 *   - the scrape request headers (Accept, X-Requested-With, Referer);
 *   - non-2xx rejection; and
 *   - the ResMan "overload" page guard — a <300-byte 200-OK body containing
 *     `<title>Error</title>`, which ResMan returns instead of real content when
 *     overwhelmed.
 *
 * Also exports `mapWithConcurrency`, the bounded worker pool the per-unit fan-out
 * uses (the scheduler in `../scheduler` is a request-level semaphore, not an
 * item-level map helper, so this is provided locally).
 */

import type { ResManClient, ResManResponse } from "../client";
import { RESMAN_SYNC_TUNING } from "../config";
import { ResManScrapingError, isResManLoginRedirect } from "../errors";

/** Swift `ResManHTTPHelper.get` default Accept. */
const DEFAULT_ACCEPT = "text/html,application/json";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry a request that failed with a transient error — a genuine network blip
 * (`networkError`, which also covers 5xx) or ResMan's under-load error page
 * (`serverOverloaded`). Backoff is `requestRetryBaseDelayMs · 2^(n-1)`, up to
 * `requestRetryAttempts`. This is what makes a higher `connectionsPerHost`
 * safe: the error pages ResMan serves under load are retried rather than
 * failing the whole unit. Auth/parse/other errors are not retried.
 */
async function withResManRetries<T>(fn: () => Promise<T>): Promise<T> {
  const { requestRetryAttempts, requestRetryBaseDelayMs } = RESMAN_SYNC_TUNING;
  let lastError: unknown;
  for (let attempt = 1; attempt <= requestRetryAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const kind = error instanceof ResManScrapingError ? error.kind : null;
      const retryable = kind === "networkError" || kind === "serverOverloaded";
      if (!retryable || attempt >= requestRetryAttempts) throw error;
      await sleep(requestRetryBaseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export class ResManScrapeHttp {
  private readonly client: ResManClient;
  private readonly baseURL: string;

  constructor(client: ResManClient) {
    this.client = client;
    this.baseURL = client.configuration.consumerStartUrl;
  }

  /** The base URL scrape source URLs are built against (Swift `http.baseURL`). */
  get base(): string {
    return this.baseURL;
  }

  /** One GET attempt through the shared client (no retry). */
  private async requestOnce(pathOrURL: string, accept: string): Promise<ResManResponse> {
    const url = pathOrURL.startsWith("http")
      ? pathOrURL
      : new URL(pathOrURL, this.baseURL).toString();

    const response = await this.client.data(
      {
        url,
        method: "GET",
        headers: {
          accept,
          "x-requested-with": "XMLHttpRequest",
          referer: this.baseURL,
        },
      },
      `GET ${pathOrURL}`,
    );

    if (response.status < 200 || response.status >= 300) {
      throw ResManScrapingError.networkError(
        new Error(`HTTP ${response.status} for ${pathOrURL}`),
      );
    }
    // A 200 that landed on the login page means the session expired mid-run:
    // ResMan served login HTML, not data. Surface it as authenticationRequired
    // (NOT retried — see withResManRetries) so the job aborts loudly instead of
    // parsing a login page as empty/garbage data. Silent data loss otherwise.
    if (isResManLoginRedirect(response.finalUrl)) {
      throw ResManScrapingError.authenticationRequired();
    }
    return response;
  }

  /**
   * Issue a GET through the shared client, resolving relative paths against the
   * consumer base and applying the scrape headers. Rejects any non-2xx response,
   * retrying transient failures. Port of `ResManHTTPHelper.get`.
   */
  async get(pathOrURL: string, accept: string = DEFAULT_ACCEPT): Promise<ResManResponse> {
    return withResManRetries(() => this.requestOnce(pathOrURL, accept));
  }

  /**
   * GET and return the response body text, guarding against the ResMan overload
   * page (a <300-byte body containing `<title>Error</title>` served with 200 OK).
   * The overload check is inside the retry so an under-load error page is
   * retried, not surfaced. Port of `ResManHTTPHelper.getText`.
   */
  async getText(pathOrURL: string): Promise<string> {
    return withResManRetries(async () => {
      const response = await this.requestOnce(pathOrURL, DEFAULT_ACCEPT);
      if (response.bytes.length < 300 && response.text.includes("<title>Error</title>")) {
        throw ResManScrapingError.serverOverloaded(pathOrURL);
      }
      return response.text;
    });
  }

  /**
   * GET a JSON endpoint (e.g. `/Units/GetBuildingsAndUnitTypes`) and parse it.
   * Uses the JSON-leaning Accept the Swift `fetchBuildingFloorplans` sends and
   * throws `parsingFailed` on invalid JSON.
   */
  async getJson(pathOrURL: string): Promise<unknown> {
    const response = await this.get(pathOrURL, "application/json,text/plain,*/*");
    try {
      return JSON.parse(response.text) as unknown;
    } catch {
      throw ResManScrapingError.parsingFailed(`Invalid JSON from ${pathOrURL}`);
    }
  }
}

/**
 * Map `items` through `fn` with at most `limit` concurrent invocations, keeping
 * the result order aligned to the input and running sequentially within each
 * worker. This mirrors the Swift per-unit worker pool (default ~6, sequential
 * within a worker) that keeps ResMan from returning error pages when too many
 * connections are opened at once (see the scraper's concurrency comments).
 *
 * The first rejection propagates (via `Promise.all`), matching the Swift task
 * group's throw-cancels-the-group behavior.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  const bound = Math.max(1, Math.floor(limit));
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  const workerCount = Math.min(bound, items.length);
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}
