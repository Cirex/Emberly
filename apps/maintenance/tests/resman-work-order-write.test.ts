import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ResManSessionExpiredError, WorkOrderWriteRefused } from "@emberly/core";

/**
 * Direct on-device writes, as React Native's fetch delivers them: the POST's
 * redirect is auto-followed (the engine sees a 200 on /WorkOrders, never the
 * 302), and success is decided purely by re-reading the form. Fixtures are
 * the REAL server-rendered edit pages captured 2026-08-26 (shared with the
 * sync worker's suite).
 */

const secure = new Map<string, string>();
mock.module("expo-secure-store", () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void secure.set(k, v),
  deleteItemAsync: async (k: string) => void secure.delete(k),
}));
mock.module("@/lib/analytics", () => ({
  capture: () => {},
  identify: () => {},
  resetAnalytics: () => {},
}));

const { useResManSession } = await import("@/lib/resman/session");
const { writeWorkOrderDirect } = await import("@/lib/resman/work-order-write");

const FIXTURES = path.join(__dirname, "..", "..", "..", "supabase", "sync", "tests", "fixtures");
const fixture = (name: string) =>
  readFileSync(path.join(FIXTURES, `work-order-edit-${name}.html`), "utf8");

const WO_16305 = "6f09851a-df4e-488f-a86b-de4a60bd4225";
const UNIT_16305 = "a478dccd-7823-463d-8df4-a2adacb573c1";
const BASE = "https://multisouth.myresman.com";
const EDIT_URL = `${BASE}/WorkOrders/Edit/${WO_16305}`;

function response(url: string, body: string, status = 200): Response {
  return { url, status, text: async () => body } as unknown as Response;
}

/** RN-flavored transport: POST answers the FOLLOWED redirect (200, list page). */
function makeTransport({ pages, pagesAfterPost }: { pages: Record<string, string>; pagesAfterPost?: Record<string, string> }) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    if (method === "POST") {
      // The native stack followed the 302 for us; all the engine sees is the
      // landing page. Cookies were persisted along the way.
      return response(`${BASE}/WorkOrders`, "<html>list</html>", 200);
    }
    const posted = calls.some((call) => call.method === "POST");
    const source = posted && pagesAfterPost ? pagesAfterPost : pages;
    const page = source[url];
    if (!page) throw new Error(`unscripted GET ${url}`);
    return response(url, page);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function landReassign(html: string, personId: string): string {
  return html.replace(
    'data-selected-value="7a2f5c20-42af-4e4e-808e-45bd64ae89c2"',
    `data-selected-value="${personId}"`,
  );
}

const ALLAN = "55e3d0ac-69e5-434b-b6fe-23fce4131ffb";
const EMPLOYEE_LIST_URL = (propertyId: string) =>
  `${BASE}/Employees/EmployeeList?propertyID=${encodeURIComponent(propertyId)}&employeeType=Maintenance`;

describe("writeWorkOrderDirect", () => {
  test("reassignment resolves the display name via EmployeeList and verifies", async () => {
    useResManSession.setState({ status: "active", username: "tech", hydrated: true });
    const pages: Record<string, string> = {
      [EDIT_URL]: fixture("16305"),
      [EMPLOYEE_LIST_URL("489f05ba-6bd4-4888-9460-88923577a6eb")]: JSON.stringify([
        { Name: "Allan Zelaya", PersonID: ALLAN },
      ]),
    };
    const transport = makeTransport({
      pages,
      pagesAfterPost: { ...pages, [EDIT_URL]: landReassign(fixture("16305"), ALLAN) },
    });
    const result = await writeWorkOrderDirect(
      {
        workOrderId: WO_16305,
        kind: "edit",
        patch: { technicianName: "allan zelaya" },
        expectedUnitId: UNIT_16305,
      },
      transport.fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(result.phase).toBe("verified");
    const post = transport.calls.find((call) => call.method === "POST");
    expect(post?.url).toBe(EDIT_URL);
    expect(post?.body).toContain(`AssignedToPersonID=${ALLAN}`);
    // ObjectID rides along from the page's data-selected-value.
    expect(post?.body).toContain(`ObjectID=${UNIT_16305}`);
  });

  test("an unknown technician refuses without a POST", async () => {
    useResManSession.setState({ status: "active", username: "tech", hydrated: true });
    const pages: Record<string, string> = {
      [EDIT_URL]: fixture("16305"),
      [EMPLOYEE_LIST_URL("489f05ba-6bd4-4888-9460-88923577a6eb")]: JSON.stringify([]),
    };
    const transport = makeTransport({ pages });
    await expect(
      writeWorkOrderDirect(
        {
          workOrderId: WO_16305,
          kind: "edit",
          patch: { technicianName: "Nobody Real" },
          expectedUnitId: UNIT_16305,
        },
        transport.fetchImpl,
      ),
    ).rejects.toBeInstanceOf(WorkOrderWriteRefused);
    expect(transport.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("an expired session short-circuits before any write traffic", async () => {
    useResManSession.setState({ status: "expired", username: "tech", hydrated: true });
    // The pre-write verify() probes the consumer root once (login bounce) and
    // must be the ONLY traffic.
    const transport = makeTransport({
      pages: {
        "https://multisouth.myresman.com/":
          "", // never used — the probe is scripted below
      },
    });
    const probe = (async (url: string) => {
      transport.calls.push({ url, method: "GET" });
      return response(
        "https://multisouth.auth.myresman.com/auth/Account/Login?ReturnUrl=x",
        "<html>login</html>",
      );
    }) as unknown as typeof fetch;
    await expect(
      writeWorkOrderDirect(
        { workOrderId: WO_16305, kind: "close", patch: {}, expectedUnitId: null },
        probe,
      ),
    ).rejects.toBeInstanceOf(ResManSessionExpiredError);
    expect(transport.calls.filter((call) => call.url.includes("/WorkOrders/"))).toHaveLength(0);
    expect(useResManSession.getState().status).toBe("expired");
  });

  test("a mid-write login bounce flips the session store to expired", async () => {
    useResManSession.setState({ status: "active", username: "tech", hydrated: true });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      void init;
      // The harvest GET bounces to the login page — session died since the
      // last check.
      return response(
        "https://multisouth.auth.myresman.com/auth/Account/Login?ReturnUrl=x",
        "<html>login</html>",
      );
    }) as unknown as typeof fetch;
    await expect(
      writeWorkOrderDirect(
        { workOrderId: WO_16305, kind: "close", patch: {}, expectedUnitId: null },
        fetchImpl,
      ),
    ).rejects.toBeInstanceOf(ResManSessionExpiredError);
    expect(useResManSession.getState().status).toBe("expired");
  });
});
