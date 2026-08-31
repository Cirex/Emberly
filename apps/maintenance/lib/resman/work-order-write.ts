import {
  MULTI_SOUTH_STAFF_PORTAL,
  ResManSessionExpiredError,
  type ResManPageHttp,
  type WorkOrderWriteRequest,
  type WorkOrderWriteResult,
  applyWorkOrderWriteWithHttp,
  employeeListPath,
  parseEmployeeList,
  resolveTechnician,
} from "@emberly/core";
import { BROWSER_UA, useResManSession } from "@/lib/resman/session";
import { withKeyedLock } from "@/lib/resman/write-lock";

/**
 * Direct on-device work-order writes — the maintenance app's adapter over the
 * shared write engine (@emberly/core resman-work-order-write, where the
 * guards, the recon, and the form-replay mechanics are documented).
 *
 * The POST goes straight to ResMan under the technician's OWN session (see
 * lib/resman/session.ts), so ResMan's audit history records the tech — no
 * server, no service account, nothing to queue centrally. Offline durability
 * is unchanged: the pending-edits/pending-closes stores already hold each
 * change un-acked until this write verifies, and retry on the sync tick.
 *
 * Transport notes: React Native's fetch auto-follows redirects and the native
 * stack persists cookies across hops, so the engine never sees a raw 302 —
 * which is fine, because the engine decides success ONLY by re-reading the
 * form. `finalUrl` (response.url) is what lets it detect a login redirect.
 */

const BASE = MULTI_SOUTH_STAFF_PORTAL.consumerStartUrl.replace(/\/$/, "");

type FetchLike = typeof fetch;

function pageHttp(fetchImpl: FetchLike): ResManPageHttp {
  return {
    async getPage(url) {
      const response = await fetchImpl(url, {
        credentials: "include",
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": BROWSER_UA },
      });
      return {
        status: response.status,
        finalUrl: response.url || url,
        text: await response.text(),
      };
    },
    async postForm(url, body) {
      const response = await fetchImpl(url, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html,application/xhtml+xml",
          "user-agent": BROWSER_UA,
        },
        body,
      });
      return {
        status: response.status,
        finalUrl: response.url || url,
        text: await response.text(),
      };
    },
  };
}

/**
 * Apply one edit/close directly to ResMan. Throws:
 *   - `ResManSessionExpiredError` when the session is gone (the session store
 *     is flipped to "expired" first, so the UI can prompt);
 *   - `WorkOrderWriteRefused` when a guard said no (deterministic);
 *   - transport errors when offline.
 * Anything returned is the engine's verified verdict.
 *
 * Serialized per work order: the whole harvest → mutate → POST → verify cycle
 * holds that ticket's lock, so a second write (the close flush and the edit
 * flush ride the same tick un-awaited) waits and re-harvests the first one's
 * result instead of POSTing a form it captured before that write landed.
 * Different work orders still run concurrently.
 */
export function writeWorkOrderDirect(
  request: WorkOrderWriteRequest,
  fetchImpl: FetchLike = fetch,
): Promise<WorkOrderWriteResult> {
  // The engine matches WorkOrderID case-insensitively, so two callers
  // spelling the same id differently must still share one lock.
  return withKeyedLock(request.workOrderId.toLowerCase(), () => writeLocked(request, fetchImpl));
}

async function writeLocked(
  request: WorkOrderWriteRequest,
  fetchImpl: FetchLike,
): Promise<WorkOrderWriteResult> {
  const session = useResManSession.getState();
  if (session.status !== "active") {
    // Short-circuit before any network: the pending stores retry every sync
    // tick, and hammering ResMan's login redirect helps nobody. verify() is
    // cheap and rescues the common cookies-outlived-the-restart case — and it
    // distinguishes a genuinely dead session (bounced to login → the layout
    // kicks to sign-in) from an unreachable ResMan (offline → plain retry,
    // NEVER a sign-out).
    const alive = await session.verify(fetchImpl);
    if (!alive) {
      if (useResManSession.getState().status === "expired") {
        throw new ResManSessionExpiredError();
      }
      throw new Error("ResMan unreachable — will retry");
    }
  }

  const wantedName = request.patch.technicianName;
  try {
    return await applyWorkOrderWriteWithHttp({
      http: pageHttp(fetchImpl),
      baseUrl: MULTI_SOUTH_STAFF_PORTAL.consumerStartUrl,
      request,
      resolveTechnicianName:
        wantedName === undefined
          ? undefined
          : async (propertyId) => {
              let response: Response;
              try {
                response = await fetchImpl(`${BASE}${employeeListPath(propertyId)}`, {
                  credentials: "include",
                  headers: {
                    accept: "application/json, text/javascript, */*; q=0.01",
                    "x-requested-with": "XMLHttpRequest",
                    "user-agent": BROWSER_UA,
                  },
                });
              } catch {
                return { error: "employee list unreachable" };
              }
              if (response.status !== 200)
                return { error: `employee list HTTP ${response.status}` };
              try {
                return resolveTechnician(
                  parseEmployeeList(JSON.parse(await response.text())),
                  wantedName,
                );
              } catch {
                return { error: "employee list did not parse" };
              }
            },
    });
  } catch (error) {
    if (error instanceof ResManSessionExpiredError) {
      useResManSession.getState().markExpired();
    }
    throw error;
  }
}
