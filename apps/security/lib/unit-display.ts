import type { ResmanUnit } from "@/lib/api/units";
import { STATUS_TINT } from "@/theme/tokens";

const NO_OCCUPANT = "No Occupant";

/**
 * The names of people actually living in the unit — empty for a vacant one.
 *
 * ResMan puts a name on a vacant unit as soon as an application is approved: as
 * of the current mirror, 45 of the 322 vacant units carry one, and every single
 * one is a `Pending` lease whose move-in date has not arrived. That person is an
 * APPLICANT, not a resident — nobody is behind that door yet. Showing the name
 * beside a "Vacant" badge read as a contradiction to everyone who saw it, on the
 * tenants list and in the map tooltip alike, so occupancy wins over the name.
 *
 * Occupied and Notice units (including Under Eviction) are untouched: those
 * names are real residents a guard can expect to meet.
 */
function occupantNames(u: ResmanUnit): string[] {
  return u.occupancy_status === "Vacant" ? [] : u.tenant_names;
}

/** Display name for a unit row — occupant name(s), else "No Occupant". */
export function unitPrimaryName(u: ResmanUnit): string {
  const names = occupantNames(u);
  return names.length > 0 ? names.join(" & ") : NO_OCCUPANT;
}

/**
 * Secondary line — the street address.
 *
 * ResMan carries both a shorthand `number` ("1709 CW-1") and the real street
 * address ("1709 Commonwealth Dr Apt 1"). The shorthand means nothing to someone
 * standing at a gate, so the address wins where it exists and the shorthand is
 * only a fallback.
 *
 * The classification ("Ruby", "Legacy") used to ride along after a "·"; it gets
 * its own line now — it's a different fact from where the unit is.
 */
export function unitLine(u: ResmanUnit): string {
  const address = u.street?.trim();
  return address || u.number;
}

/** Floor-plan / product name ("Ruby", "Diamond", "Legacy"), if ResMan has one. */
export function unitClassification(u: ResmanUnit): string {
  return u.classification?.trim() ?? "";
}

/** Occupancy → badge label + tint. */
export function unitStatus(u: ResmanUnit): { label: string; tint: string } {
  switch (u.occupancy_status) {
    case "Occupied":
      return { label: "Occupied", tint: STATUS_TINT.ready };
    case "Notice": {
      // "Notice" is an umbrella occupancy covering two very different states:
      // as of the current sync, 56 of the 60 units in it are Under Eviction and
      // only 4 gave notice voluntarily. The lease status is the only field that
      // says which, so read it rather than flattening evictions into the softer
      // label — the difference is exactly what a guard needs at the gate.
      const lease = u.lease_status?.trim();
      if (lease === "Under Eviction") return { label: "Under Eviction", tint: STATUS_TINT.blocked };
      return { label: lease || "Notice", tint: STATUS_TINT.warning };
    }
    case "Vacant":
      return { label: "Vacant", tint: STATUS_TINT.info };
    default:
      return { label: u.availability || "Unknown", tint: STATUS_TINT.info };
  }
}

/**
 * "Last synced Jul 13, 4:24 AM" from the newest stamp among the loaded units.
 *
 * A sync run stamps the whole mirror at once (the entire table lands inside a
 * couple hundred milliseconds), so the newest stamp on the loaded page is the
 * run's time for every unit — no need to ask the server separately.
 */
export function lastSyncedLabel(units: ResmanUnit[]): string {
  let newest = 0;
  for (const u of units) {
    const at = u.synced_at ? Date.parse(u.synced_at) : NaN;
    if (!Number.isNaN(at) && at > newest) newest = at;
  }
  if (!newest) return "Never synced";
  const when = new Date(newest).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Last synced ${when}`;
}

/**
 * Two-letter initials from the first occupant, else the unit number.
 *
 * Reads through `occupantNames`, so a vacant unit falls back to its number
 * rather than showing an applicant's initials in the avatar disc — the label
 * beside it says "No Occupant", and the two must not disagree.
 */
export function unitInitials(u: ResmanUnit): string {
  const name = occupantNames(u)[0];
  if (name) {
    const parts = name.trim().split(/\s+/);
    const initials = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
    if (initials) return initials.toUpperCase();
  }
  return (u.number || "?").slice(0, 2).toUpperCase();
}
