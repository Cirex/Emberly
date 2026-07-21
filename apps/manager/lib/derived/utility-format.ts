/**
 * Display formatting for the Utilities board — pure, tested, no React.
 * Currency is always USD with a "$" sign (MLGW bills); locale only affects
 * date/month names. Every function coalesces null/undefined/NaN to a safe
 * rendering — the charge-total extraction seam can hand us anything.
 */

const safe = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

function withThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "$212.40" / "-$34.10". Cents always shown — ledger rows and tables. */
export function formatMoney(value: number | null | undefined): string {
  const v = safe(value);
  const sign = v < 0 ? "-" : "";
  const fixed = Math.abs(v).toFixed(2);
  const [whole, cents] = fixed.split(".");
  return `${sign}$${withThousands(whole)}.${cents}`;
}

/** "$9,812" (whole dollars) — metric strip and band totals. Uses "$120k" only
 *  from six figures up, where cents-precision stops meaning anything. */
export function formatMoneyWhole(value: number | null | undefined): string {
  const v = safe(value);
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 100_000) return `${sign}$${withThousands(String(Math.round(abs / 1000)))}k`;
  return `${sign}$${withThousands(String(Math.round(abs)))}`;
}

/** "+7.8%" / "−1.4%" (typographic minus); null → "—". */
export function formatDeltaPct(deltaPct: number | null | undefined): string {
  if (deltaPct === null || deltaPct === undefined || !Number.isFinite(deltaPct)) return "—";
  const rounded = Math.round(deltaPct * 10) / 10;
  if (rounded === 0) return "0%";
  return rounded > 0 ? `+${rounded}%` : `−${Math.abs(rounded)}%`;
}

/** "Jul 18" from "YYYY-MM-DD(...)". Bad input → "". UTC so the feed's plain
 *  dates never shift a day across timezones. */
export function formatShortDate(iso: string | null | undefined, locale: string): string {
  const dayPart = (iso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPart)) return "";
  const d = new Date(`${dayPart}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Jul" from "YYYY-MM". Bad input → "". */
export function formatMonthLabel(month: string | null | undefined, locale: string): string {
  const m = (month ?? "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return "";
  const d = new Date(`${m}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale, { month: "short", timeZone: "UTC" });
}

/** "···8841" — the trailing digits of an account number for compact display. */
export function accountLast4(accountNumber: string | null | undefined): string {
  const digits = (accountNumber ?? "").replace(/\D/g, "");
  return digits.length > 4 ? digits.slice(-4) : digits || "····";
}
