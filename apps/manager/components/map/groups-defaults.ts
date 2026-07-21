import type { MapFilterGroup } from "@emberly/core";

/**
 * The manager's prebuilt leasing groups — the "Groups · Leasing" lens of the
 * approved mockup. Kept in a pure module (no store, no RN imports) so tests
 * can exercise the definitions against buildGroupPaint directly.
 *
 * "Applicant attached" from the mockup is deliberately ABSENT: the manager
 * units DTO carries no pending-lease/applicant field, so the condition
 * vocabulary cannot express it yet. It joins when applicant sync lands.
 *
 * Names are seed DATA (user-editable, persisted), not UI strings — same
 * posture as core's defaultMapFilterGroups, so they are not localized.
 */
export function defaultManagerMapGroups(): MapFilterGroup[] {
  return [
    {
      id: "prebuilt-vacant-ready",
      name: "Vacant ready",
      colorHex: "#378ADD",
      // availability mirrors ResMan's UnitStatus column ("Ready", "Not Ready",
      // "Model", "Down", …); vacant + made-ready is the leasable set.
      conditions: [
        { kind: "occupancy", value: "Vacant" },
        { kind: "availabilityIn", values: ["Ready"] },
      ],
      visible: true,
    },
    {
      id: "prebuilt-lease-ending",
      name: "Lease ends 30d",
      colorHex: "#EF9F27",
      conditions: [{ kind: "leaseEndsWithin", days: 30 }],
      visible: true,
    },
    {
      id: "prebuilt-eviction",
      name: "Eviction",
      colorHex: "#7A1F1F",
      conditions: [{ kind: "evictionFlag" }],
      visible: true,
    },
    {
      id: "prebuilt-balance-800",
      name: "Balance > $800",
      colorHex: "#D1382E",
      conditions: [{ kind: "balanceBand", min: 800, max: null }],
      visible: true,
    },
  ];
}
