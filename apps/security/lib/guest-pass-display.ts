import type { PassStatus } from "@/lib/api/guest-passes";
import { STATUS_TINT } from "@/theme/tokens";

/** Guest-pass status → chip label + tint. Revoked reads as "Needs Review". */
export const PASS_STATUS_META: Record<PassStatus, { label: string; tint: string }> = {
  active: { label: "Active", tint: STATUS_TINT.ready },
  used: { label: "Used", tint: STATUS_TINT.info },
  expired: { label: "Expired", tint: STATUS_TINT.warning },
  revoked: { label: "Needs Review", tint: STATUS_TINT.review },
};

/** The filter chips shown in the feed (order matters). */
export const PASS_FILTERS: PassStatus[] = ["active", "used", "expired", "revoked"];
