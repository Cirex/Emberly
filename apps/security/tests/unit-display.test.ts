import { describe, expect, test } from "bun:test";
import type { ResmanUnit } from "@/lib/api/units";
import { unitInitials, unitPrimaryName, unitStatus } from "@/lib/unit-display";

/**
 * A vacant unit must never show a person's name.
 *
 * ResMan attaches a name to a unit the moment an application is approved, well
 * before anyone moves in. In the mirror as of 2026-08-10 that is 45 of the 322
 * vacant units, and all 45 are `Pending` leases — applicants, not residents. The
 * tenants list and the map tooltip both rendered that name straight from
 * `tenant_names`, so a guard saw a resident's name beside a "Vacant" badge and
 * had no way to tell which one to believe.
 *
 * Occupied and Notice units keep their names: those are people a guard can
 * actually expect to find behind the door, and "Under Eviction" in particular is
 * exactly the case where knowing the name matters most.
 */

function unit(over: Partial<ResmanUnit> = {}): ResmanUnit {
  return {
    resman_unit_id: "u1",
    number: "1731 ST-3",
    occupancy_status: "Occupied",
    tenant_names: [],
    ...over,
  } as ResmanUnit;
}

describe("vacant units have no occupant", () => {
  test("a pending applicant's name is not shown as the occupant", () => {
    const u = unit({
      occupancy_status: "Vacant",
      lease_status: "Pending",
      tenant_names: ["Garon Seals"],
    });
    expect(unitPrimaryName(u)).toBe("No Occupant");
    expect(unitPrimaryName(u)).not.toContain("Garon");
  });

  test("the avatar falls back to the unit number, not the applicant's initials", () => {
    const u = unit({
      occupancy_status: "Vacant",
      lease_status: "Pending",
      tenant_names: ["Garon Seals"],
      number: "1731 ST-3",
    });
    // "GS" would contradict the "No Occupant" label sitting right beside it.
    expect(unitInitials(u)).toBe("17");
  });

  test("a vacant unit with no name reads the same as one with an applicant", () => {
    const named = unit({ occupancy_status: "Vacant", tenant_names: ["Ashley Jett"] });
    const empty = unit({ occupancy_status: "Vacant", tenant_names: [] });
    expect(unitPrimaryName(named)).toBe(unitPrimaryName(empty));
  });

  test("the status badge still says Vacant — only the name line changed", () => {
    const u = unit({ occupancy_status: "Vacant", tenant_names: ["Erick Foster"] });
    expect(unitStatus(u).label).toBe("Vacant");
  });
});

describe("real occupants are untouched", () => {
  test("an occupied unit shows its resident", () => {
    const u = unit({ occupancy_status: "Occupied", tenant_names: ["Mckenzie Wolf"] });
    expect(unitPrimaryName(u)).toBe("Mckenzie Wolf");
    expect(unitInitials(u)).toBe("MW");
  });

  test("co-residents are joined", () => {
    const u = unit({ occupancy_status: "Occupied", tenant_names: ["Ada Lin", "Bo Reed"] });
    expect(unitPrimaryName(u)).toBe("Ada Lin & Bo Reed");
  });

  test("a unit under eviction still names the resident", () => {
    const u = unit({
      occupancy_status: "Notice",
      lease_status: "Under Eviction",
      tenant_names: ["Keira Carlton"],
    });
    expect(unitPrimaryName(u)).toBe("Keira Carlton");
    expect(unitStatus(u).label).toBe("Under Eviction");
  });

  test("an occupied unit with no name still reads as empty rather than blank", () => {
    expect(unitPrimaryName(unit({ occupancy_status: "Occupied", tenant_names: [] }))).toBe(
      "No Occupant",
    );
  });
});
