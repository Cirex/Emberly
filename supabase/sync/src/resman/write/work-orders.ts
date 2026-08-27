/**
 * The sync worker's adapter over the shared work-order write ENGINE
 * (@emberly/core resman-work-order-write) — the engine, its guards, and the
 * recon that produced them are documented there. This file only:
 *
 *   - adapts `ResManClient` (cookie jar, scheduler choke point, manual
 *     redirects) to the engine's transport interface — the POST uses
 *     `redirect: "manual"` so the log can record the true 302, which
 *     React Native's transport cannot see (the engine never NEEDS it: success
 *     is decided by re-reading the form);
 *   - maps the engine's session-expiry signal onto
 *     `ResManScrapingError.authenticationRequired`, which is what the flush
 *     job (and every other sync job) keys its abort-the-run behavior on.
 *
 * The maintenance app has its own thin adapter over the same engine for
 * direct on-device writes under the technician's session; this path remains
 * for office-side tooling and as the queue-drain fallback.
 */

import {
  type ResManPageHttp,
  type WorkOrderWriteRequest,
  type WorkOrderWriteResult,
  ResManSessionExpiredError,
  applyWorkOrderWriteWithHttp,
  verifyWorkOrderWriteWithHttp,
} from "@emberly/core";
import type { ResManClient } from "../client";
import { ResManScrapingError } from "../errors";

export {
  RESMAN_DESCRIPTION_MAX,
  WorkOrderWriteRefused,
  type WorkOrderWritePatch,
  type WorkOrderWritePhase,
  type WorkOrderWriteRequest,
  type WorkOrderWriteResult,
} from "@emberly/core";

export interface ApplyWorkOrderWriteParams {
  client: ResManClient;
  request: WorkOrderWriteRequest;
  log?: (message: string) => void;
  /** Injected for tests. */
  now?: () => Date;
}

/** The engine's transport, backed by the shared authenticated client. */
function httpFor(client: ResManClient): ResManPageHttp {
  const base = client.configuration.consumerStartUrl.replace(/\/$/, "");
  return {
    async getPage(url) {
      const response = await client.data(
        { url, method: "GET", headers: { referer: base } },
        `GET work-order page`,
      );
      return { status: response.status, finalUrl: response.finalUrl, text: response.text };
    },
    async postForm(url, body, referer) {
      const response = await client.data(
        {
          url,
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            referer,
            origin: base,
          },
          body,
        },
        `POST work-order form`,
      );
      // With redirect:"manual" a successful save is the 302 itself; surface
      // the Location as the final URL so the engine's login-redirect check
      // sees where ResMan was sending us.
      const location = response.headers.get("location");
      return {
        status: response.status,
        finalUrl: location ? new URL(location, url).toString() : response.finalUrl,
        text: response.text,
      };
    },
  };
}

/** Map the engine's session signal onto the sync error the jobs key on. */
async function translatingSessionExpiry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ResManSessionExpiredError) {
      throw ResManScrapingError.authenticationRequired();
    }
    throw error;
  }
}

/**
 * Apply one edit/close to ResMan through the shared client. Throws
 * `WorkOrderWriteRefused` (nothing was sent) or `ResManScrapingError`; the
 * flush job maps phases to queue-row outcomes.
 */
export async function applyWorkOrderWrite(
  params: ApplyWorkOrderWriteParams,
): Promise<WorkOrderWriteResult> {
  return translatingSessionExpiry(() =>
    applyWorkOrderWriteWithHttp({
      http: httpFor(params.client),
      baseUrl: params.client.configuration.consumerStartUrl,
      request: params.request,
      log: params.log,
      now: params.now,
    }),
  );
}

/**
 * Verify-only reconcile for a row whose earlier attempt POSTed but could not
 * confirm: re-read the form and report whether the targets are present now.
 */
export async function verifyWorkOrderWrite(
  params: ApplyWorkOrderWriteParams,
): Promise<WorkOrderWriteResult> {
  return translatingSessionExpiry(() =>
    verifyWorkOrderWriteWithHttp({
      http: httpFor(params.client),
      baseUrl: params.client.configuration.consumerStartUrl,
      request: params.request,
      log: params.log,
      now: params.now,
    }),
  );
}
