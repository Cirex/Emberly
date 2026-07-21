import { activeLocale } from "@/lib/i18n";
import type { TenantInsurance, TenantProfile } from "@/lib/api/people";

/**
 * Display formatting and profile derivations for the People directory.
 *
 * Deliberately free of react-native imports so every rule here stays unit
 * testable — the components consume it, not the other way round.
 */

export function fmtMoney(value: number): string {
  const sign = value < 0 ? "−" : "";
  return `${sign}$${Math.round(Math.abs(value)).toLocaleString(activeLocale())}`;
}

/** Compact for the metric strip: $18.4k above 10k, plain dollars below. */
export function fmtMoneyCompact(value: number): string {
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${sign}$${Math.round(abs).toLocaleString(activeLocale())}`;
}

export function fmtPercent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits).replace(/\.0$/, "")}%`;
}

/** "Jul 30" — short date from an ISO string; empty for unparseable input. */
export function fmtShortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleDateString(activeLocale(), { month: "short", day: "numeric" });
}

/** "May 2024" — month-year from an ISO date or a "YYYY-MM" string. */
export function fmtMonthYear(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return "";
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(activeLocale(), {
    month: "short",
    year: "numeric",
  });
}

/** "04 / 02 / 1988" — a revealed birthdate, spaced like the masked form. */
export function fmtBirthdate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[2]} / ${m[3]} / ${m[1]}`;
}

/**
 * Whole days from `nowMs` to an ISO date. Negative = already past. `null` when
 * the date is missing or unparseable, so callers render "—" rather than NaN.
 */
export function daysUntil(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.round((ms - nowMs) / 86_400_000);
}

/** "(901) 555-0112" for 10-digit US numbers; anything else is left verbatim. */
export function fmtPhone(raw: string): string {
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw.trim();
}

/** Last four of a policy number, dotted: "···4471". */
export function policyLast4(policyNumber: string): string {
  const trimmed = policyNumber.trim();
  if (trimmed === "") return "—";
  return trimmed.length <= 4 ? trimmed : `···${trimmed.slice(-4)}`;
}

/** Two-letter initials from a name; "—" when there is nothing to initial. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Ratio → the affordability verdict the profile prints beside it. */
export type IncomeVerdict = "healthy" | "elevated" | "strained";

export function incomeVerdict(ratio: number): IncomeVerdict {
  if (ratio <= 0.3) return "healthy";
  if (ratio <= 0.4) return "elevated";
  return "strained";
}

/** The policy that matters: the one that runs out last. */
export function currentPolicy(policies: TenantInsurance[]): TenantInsurance | null {
  if (policies.length === 0) return null;
  return [...policies].sort((a, b) => (b.endDate ?? "").localeCompare(a.endDate ?? ""))[0];
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** "Unit 0327 · 2BR Diamond · primary · in since May 2024 · lease ends Jul 31" */
export function profileSubline(profile: TenantProfile | null, t: Translate): string {
  if (!profile) return "";
  const lease = profile.lease;
  const parts: string[] = [];
  if (lease?.unitNumber) parts.push(t("people.subline.unit", { unit: lease.unitNumber }));
  if (lease?.bedrooms) {
    parts.push(`${lease.bedrooms}BR${lease.classification ? ` ${lease.classification}` : ""}`);
  } else if (lease?.classification) {
    parts.push(lease.classification);
  }
  parts.push(profile.resident.isPrimary ? t("people.row.primary") : t("people.row.occupant"));
  if (lease?.moveInDate) {
    parts.push(t("people.subline.inSince", { date: fmtMonthYear(lease.moveInDate) }));
  }
  if (lease?.leaseEnd) parts.push(t("people.row.leaseEnds", { date: fmtShortDate(lease.leaseEnd) }));
  if (lease?.residentRent) {
    parts.push(t("people.subline.perMonth", { amount: fmtMoney(lease.residentRent) }));
  }
  if (lease?.leasingAgent) parts.push(t("people.subline.agent", { agent: lease.leasingAgent }));
  return parts.join(" · ");
}
