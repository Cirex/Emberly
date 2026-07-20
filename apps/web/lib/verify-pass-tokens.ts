export type VerifyPassTokenClassification =
  | { type: "resident-entry"; parsed: string }
  | { type: "guest-entry"; parsed: string }
  | { type: "guest-share"; parsed: string }
  | { type: "unknown"; parsed: string };

import { GUEST_ENTRY_TOKEN_PREFIX, RESIDENT_ENTRY_TOKEN_PREFIX } from "@emberly/core";

export function extractGuestShareTokenFromQr(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) return null;

  try {
    const url = trimmed.startsWith("/")
      ? new URL(trimmed, "https://emberly.local")
      : new URL(trimmed);
    const segments = url.pathname.split("/").filter(Boolean);
    const guestPassIndex = segments.indexOf("guest-pass");
    const shareToken = guestPassIndex >= 0 ? segments[guestPassIndex + 1] : null;
    return shareToken ? decodeURIComponent(shareToken).trim() || null : null;
  } catch {
    return null;
  }
}

export function classifyVerifyPassToken(token: string): VerifyPassTokenClassification {
  const trimmed = token.trim();

  if (trimmed.startsWith(RESIDENT_ENTRY_TOKEN_PREFIX)) {
    return { type: "resident-entry", parsed: trimmed };
  }

  if (trimmed.startsWith(GUEST_ENTRY_TOKEN_PREFIX)) {
    return { type: "guest-entry", parsed: trimmed };
  }

  const shareToken = extractGuestShareTokenFromQr(trimmed);
  if (shareToken) {
    return { type: "guest-share", parsed: shareToken };
  }

  return { type: "unknown", parsed: trimmed };
}
