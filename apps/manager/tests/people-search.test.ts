import { describe, expect, test } from "bun:test";
import {
  currentPolicy,
  daysUntil,
  fmtBirthdate,
  fmtPhone,
  incomeVerdict,
  policyLast4,
  profileSubline,
} from "@/components/people/format";
import {
  digitsOnly,
  directoryTotals,
  fullName,
  matchesName,
  matchesPhone,
  matchesPlate,
  matchesUnit,
  normalizePlate,
  normalizeQuery,
  searchPeople,
} from "@/components/people/search";
import type { PeopleIndexEntry, TenantInsurance, TenantProfile } from "@/lib/api/people";

function person(over: Partial<PeopleIndexEntry> = {}): PeopleIndexEntry {
  return {
    personLeaseId: "pl-1",
    personId: "p-1",
    leaseId: "l-1",
    unitNumber: "0327",
    firstName: "Carmen",
    lastName: "Reyes",
    isPrimary: true,
    householdStatus: "Current",
    phones: ["(901) 555-0112"],
    email: "carmen@example.com",
    vehicles: [{ plate: "7REY220", state: "TN" }],
    ...over,
  };
}

const DIEGO = person({
  personLeaseId: "pl-2",
  firstName: "Diego",
  lastName: "Reyes",
  isPrimary: false,
  householdStatus: "Occupant",
  phones: ["9015550133"],
  vehicles: [],
});
const KWAME = person({
  personLeaseId: "pl-3",
  firstName: "Kwame",
  lastName: "Okafor",
  unitNumber: "0538",
  phones: ["(901) 555-0777"],
  vehicles: [{ plate: "4KLM881", state: "TN" }],
});

const INDEX = [KWAME, person(), DIEGO];

describe("normalizers", () => {
  test("query is trimmed, folded and collapsed", () => {
    expect(normalizeQuery("  Carmen   REYES ")).toBe("carmen reyes");
  });

  test("digits and plates strip their separators", () => {
    expect(digitsOnly("(901) 555-0112")).toBe("9015550112");
    expect(normalizePlate(" 7rey-220 ")).toBe("7REY220");
  });

  test("fullName tolerates a missing half", () => {
    expect(fullName({ firstName: "Carmen", lastName: "Reyes" })).toBe("Carmen Reyes");
    expect(fullName({ firstName: "", lastName: "Reyes" })).toBe("Reyes");
  });
});

describe("field matchers", () => {
  test("name matches first, last and 'first last'", () => {
    const p = person();
    expect(matchesName(p, "car")).toBe(true);
    expect(matchesName(p, "rey")).toBe(true);
    expect(matchesName(p, "carmen rey")).toBe(true);
    expect(matchesName(p, "reyes carmen")).toBe(false);
    expect(matchesName(p, "okafor")).toBe(false);
  });

  test("phone compares digits-only, and ignores 1–2 digit queries", () => {
    const p = person();
    expect(matchesPhone(p, "9015550112")).toBe(true);
    expect(matchesPhone(p, "5550112")).toBe(true);
    expect(matchesPhone(p, "01")).toBe(false);
  });

  test("unit matches the raw number and its digits", () => {
    expect(matchesUnit("0327", "0327", "0327")).toBe(true);
    expect(matchesUnit("0327", "327", "327")).toBe(true);
    expect(matchesUnit("0327", "0538", "0538")).toBe(false);
    expect(matchesUnit("", "0327", "0327")).toBe(false);
  });

  test("plate is case- and separator-insensitive, with or without the state", () => {
    const v = { plate: "7REY220", state: "TN" };
    expect(matchesPlate(v, normalizePlate("7rey220"))).toBe(true);
    // Spaces and dashes are stripped on both sides, so a plate typed the way
    // it is painted still lands.
    expect(matchesPlate(v, normalizePlate("7rey 220"))).toBe(true);
    expect(matchesPlate(v, normalizePlate("rey220"))).toBe(true);
    expect(matchesPlate(v, normalizePlate("4klm881"))).toBe(false);
    expect(matchesPlate(v, normalizePlate("tn7rey"))).toBe(true);
    expect(matchesPlate(v, "")).toBe(false);
  });
});

describe("searchPeople", () => {
  test("a blank query is the whole directory, with no plate or unit noise", () => {
    const r = searchPeople(INDEX, "   ");
    expect(r.people).toHaveLength(3);
    expect(r.plates).toHaveLength(0);
    expect(r.units).toHaveLength(0);
    expect(r.counts.all).toBe(3);
  });

  test("a surname groups people, their plates and their units (the mockup case)", () => {
    const r = searchPeople(INDEX, "rey");
    expect(r.people.map((p) => p.firstName)).toEqual(["Carmen", "Diego"]);
    // "rey" is inside 7REY220, so the plate group answers too.
    expect(r.plates.map((p) => p.plate)).toEqual(["7REY220"]);
    expect(r.plates[0].name).toBe("Carmen Reyes");
    // The unit shows up because the matched people live there.
    expect(r.units.map((u) => u.unitNumber)).toEqual(["0327"]);
    expect(r.units[0].residentCount).toBe(2);
    expect(r.units[0].primaryName).toBe("Carmen Reyes");
    expect(r.counts).toEqual({ all: 4, people: 2, plates: 1, units: 1 });
  });

  test("a unit number returns the unit and everyone on it", () => {
    const r = searchPeople(INDEX, "0538");
    expect(r.units.map((u) => u.unitNumber)).toEqual(["0538"]);
    expect(r.people).toHaveLength(0);
    expect(r.counts.units).toBe(1);
  });

  test("a phone fragment finds the person without leaking into other groups", () => {
    const r = searchPeople(INDEX, "555-0133");
    expect(r.people.map((p) => p.firstName)).toEqual(["Diego"]);
    expect(r.plates).toHaveLength(0);
  });

  test("a plate finds the owner's car and their unit", () => {
    const r = searchPeople(INDEX, "4klm881");
    expect(r.plates).toHaveLength(1);
    expect(r.plates[0].personLeaseId).toBe("pl-3");
    expect(r.plates[0].unitNumber).toBe("0538");
    expect(r.units.map((u) => u.unitNumber)).toEqual(["0538"]);
  });

  test("no match yields empty groups, not an error", () => {
    const r = searchPeople(INDEX, "zzzz");
    expect(r.counts).toEqual({ all: 0, people: 0, plates: 0, units: 0 });
  });

  test("matched people keep the index's order (the API sorts by surname)", () => {
    const r = searchPeople(INDEX, "e");
    expect(r.people.map((p) => p.lastName)).toEqual(["Okafor", "Reyes", "Reyes"]);
  });
});

describe("directoryTotals", () => {
  test("splits primaries from household members and counts vehicles", () => {
    expect(directoryTotals(INDEX)).toEqual({
      residents: 3,
      primaries: 2,
      householdMembers: 1,
      vehicles: 2,
    });
  });
});

describe("profile formatting", () => {
  test("daysUntil is signed and null-safe", () => {
    const now = Date.parse("2026-07-21T00:00:00Z");
    expect(daysUntil("2026-07-30T00:00:00Z", now)).toBe(9);
    expect(daysUntil("2026-04-02T00:00:00Z", now)).toBe(-110);
    expect(daysUntil(null, now)).toBe(null);
    expect(daysUntil("not-a-date", now)).toBe(null);
  });

  test("phones format to US shape and leave anything else alone", () => {
    expect(fmtPhone("9015550112")).toBe("(901) 555-0112");
    expect(fmtPhone("19015550112")).toBe("(901) 555-0112");
    expect(fmtPhone("+44 20 7123 4567")).toBe("+44 20 7123 4567");
  });

  test("policy numbers show only their last four", () => {
    expect(policyLast4("RN-88204471")).toBe("···4471");
    expect(policyLast4("")).toBe("—");
  });

  test("revealed birthdates render in the masked field's shape", () => {
    expect(fmtBirthdate("1988-04-02")).toBe("04 / 02 / 1988");
    expect(fmtBirthdate(null)).toBe("");
  });

  test("rent-to-income verdicts break at 30% and 40%", () => {
    expect(incomeVerdict(0.2756)).toBe("healthy");
    expect(incomeVerdict(0.3)).toBe("healthy");
    expect(incomeVerdict(0.35)).toBe("elevated");
    expect(incomeVerdict(0.55)).toBe("strained");
  });

  test("currentPolicy picks the one that runs out last", () => {
    const policy = (id: string, endDate: string | null): TenantInsurance => ({
      id,
      provider: "State Farm",
      policyNumber: "4471",
      policyType: "Renters",
      status: "Active",
      startDate: null,
      endDate,
      coverageAmount: 100000,
    });
    expect(currentPolicy([])).toBe(null);
    expect(currentPolicy([policy("a", "2025-07-30"), policy("b", "2026-07-30")])?.id).toBe("b");
  });
});

describe("profileSubline", () => {
  const t: (key: string, options?: Record<string, unknown>) => string = (key, options) =>
    options ? `${key}(${Object.values(options).join(",")})` : key;

  test("is empty without a profile", () => {
    expect(profileSubline(null, t)).toBe("");
  });

  test("assembles unit, classification, role, tenure, lease end, rent and agent", () => {
    const profile = {
      resident: { isPrimary: true },
      lease: {
        unitNumber: "0327",
        bedrooms: 2,
        classification: "Diamond",
        moveInDate: "2024-05-04",
        leaseEnd: "2026-07-31",
        residentRent: 1240,
        leasingAgent: "QH",
      },
    } as unknown as TenantProfile;
    const line = profileSubline(profile, t);
    expect(line).toContain("people.subline.unit(0327)");
    expect(line).toContain("2BR Diamond");
    expect(line).toContain("people.row.primary");
    expect(line).toContain("people.row.leaseEnds");
    expect(line).toContain("people.subline.agent(QH)");
  });
});
