import { describe, expect, test } from "bun:test";
import {
  MANAGER_ALERT_KINDS,
  MANAGER_ALERT_ROUTES,
  isManagerAlertKind,
  managerPushTargetFrom,
} from "@/lib/push-routing";

// The payload shape the sync worker sends (supabase/sync/src/manager/alerts.ts
// buildManagerPushMessages): { route, kind, id }.
const payload = (overrides: Record<string, unknown> = {}) => ({
  route: "/(tabs)/delinquency",
  kind: "balance_threshold",
  id: "unit-42",
  ...overrides,
});

describe("managerPushTargetFrom", () => {
  test("maps a worker payload to its route, kind, and id", () => {
    expect(managerPushTargetFrom(payload())).toEqual({
      route: "/(tabs)/delinquency",
      kind: "balance_threshold",
      id: "unit-42",
    });
  });

  test("accepts every route the worker can send", () => {
    for (const route of MANAGER_ALERT_ROUTES) {
      expect(managerPushTargetFrom(payload({ route }))?.route).toBe(route);
    }
  });

  test("rejects routes outside the allow-list — push payloads are untrusted", () => {
    expect(managerPushTargetFrom(payload({ route: "/settings" }))).toBeNull();
    expect(managerPushTargetFrom(payload({ route: "https://evil.example" }))).toBeNull();
    expect(managerPushTargetFrom(payload({ route: "" }))).toBeNull();
  });

  test("kind and id are advisory: unknown kind nulls, missing id nulls", () => {
    // A future server may send kinds this build doesn't know — route still works.
    expect(managerPushTargetFrom(payload({ kind: undefined }))).toEqual({
      route: "/(tabs)/delinquency",
      kind: null,
      id: "unit-42",
    });
    expect(managerPushTargetFrom(payload({ kind: "brand_new_kind" }))).toBeNull();
    expect(managerPushTargetFrom(payload({ id: undefined }))?.id).toBeNull();
    expect(managerPushTargetFrom(payload({ id: null }))?.id).toBeNull();
  });

  test("normalizes a numeric id to a string", () => {
    expect(managerPushTargetFrom(payload({ id: 7 }))?.id).toBe("7");
  });

  test("returns null for non-alert payloads", () => {
    expect(managerPushTargetFrom(undefined)).toBeNull();
    expect(managerPushTargetFrom(null)).toBeNull();
    expect(managerPushTargetFrom("string")).toBeNull();
    // A maintenance-app emergency payload that somehow reached this app.
    expect(managerPushTargetFrom({ workOrderId: "wo-1", unitNumber: "12" })).toBeNull();
  });
});

describe("isManagerAlertKind", () => {
  test("accepts exactly the seven kinds", () => {
    expect(MANAGER_ALERT_KINDS).toHaveLength(7);
    expect(MANAGER_ALERT_KINDS).toContain("renewal_offer_silent");
    expect(MANAGER_ALERT_KINDS).toContain("policy_lapsed");
    for (const kind of MANAGER_ALERT_KINDS) expect(isManagerAlertKind(kind)).toBe(true);
    expect(isManagerAlertKind("emergency_work_order")).toBe(false);
    expect(isManagerAlertKind(undefined)).toBe(false);
    expect(isManagerAlertKind(3)).toBe(false);
  });
});
