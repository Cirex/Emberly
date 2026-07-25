import { describe, expect, test } from "bun:test";
import { emergencyAlertNotice } from "@/lib/push/availability-notice";
import type { PushRegistration } from "@/lib/push";

/**
 * What the tech is told when turning emergency alerts on doesn't work.
 *
 * The rule being pinned: SILENCE IS ONLY FOR NON-FAILURES. Push registration
 * failed on every device in the fleet for an unknown length of time and produced
 * no signal at all — the toggle went green, the tech assumed alerts were on, and
 * emergency work orders reached nobody. Anything that leaves the tech with a
 * false belief has to speak up.
 */

const fail = (reason: string, detail?: string): PushRegistration =>
  ({ ok: false, reason, detail }) as PushRegistration;

describe("emergencyAlertNotice", () => {
  test("says nothing when there is no failure to report", () => {
    expect(emergencyAlertNotice({ ok: true, alreadyRegistered: false })).toBeNull();
    expect(emergencyAlertNotice({ ok: true, alreadyRegistered: true })).toBeNull();
    // Not failures: the tech turned alerts off, or a call is already running.
    expect(emergencyAlertNotice(fail("alerts_off"))).toBeNull();
    expect(emergencyAlertNotice(fail("in_flight"))).toBeNull();
    // A developer-only condition — a tech never sees a simulator.
    expect(emergencyAlertNotice(fail("simulator"))).toBeNull();
  });

  test("EVERY other reason produces a notice — silence is the bug", () => {
    // Enumerated deliberately: a new reason added to lib/push.ts without a
    // notice would otherwise inherit silence, which is the exact failure mode
    // this module exists to prevent.
    for (const reason of [
      "permission_denied",
      "no_push_entitlement",
      "no_project_id",
      "server_rejected",
      "unknown",
    ]) {
      const notice = emergencyAlertNotice(fail(reason));
      expect(notice, `${reason} produced no notice`).not.toBeNull();
      expect(notice?.title.length ?? 0).toBeGreaterThan(0);
      expect(notice?.body.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("a denied permission tells the tech exactly where to fix it", () => {
    const notice = emergencyAlertNotice(fail("permission_denied"));
    // The one case they can resolve alone, so the path must be spelled out.
    expect(notice?.body).toContain("Settings");
    expect(notice?.body).toContain("Notifications");
  });

  test("a build problem does not blame the tech or imply they can fix it", () => {
    for (const reason of ["no_push_entitlement", "no_project_id"]) {
      const notice = emergencyAlertNotice(fail(reason));
      // Nothing that sends them into iOS Settings to hunt a toggle that isn't
      // the problem.
      expect(notice?.body).not.toContain("Allow Notifications");
      // And it must not quietly imply alerts now work.
      expect(notice?.body.toLowerCase()).toContain("won't");
    }
  });

  test("an unknown failure passes the underlying detail through", () => {
    const notice = emergencyAlertNotice(fail("unknown", "APNs handshake timed out"));
    expect(notice?.body).toContain("APNs handshake timed out");
  });
});
