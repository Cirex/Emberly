import { networkInterfaces } from "node:os";
import {
  PRODUCTION_ORIGIN,
  formatShortDateTime,
  getGuestPassStatus,
  type PassStatus,
} from "@emberly/core";

export const DEFAULT_PUBLIC_GUEST_PASS_ORIGIN = PRODUCTION_ORIGIN;

function localLanHost(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return null;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0";
}

function vercelDeploymentOrigin(): string | null {
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (!vercelUrl) return null;

  return vercelUrl.startsWith("http://") || vercelUrl.startsWith("https://")
    ? vercelUrl
    : `https://${vercelUrl}`;
}

function guestPassOrigin(requestUrl: string): string {
  if (process.env.NODE_ENV === "production") {
    const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
    if (configuredUrl) return configuredUrl;

    const deploymentUrl = vercelDeploymentOrigin();
    if (deploymentUrl) return deploymentUrl;

    return DEFAULT_PUBLIC_GUEST_PASS_ORIGIN;
  }

  const devUrl = process.env.LOCAL_LAN_APP_URL?.trim();
  if (devUrl) return devUrl;

  const url = new URL(requestUrl);
  if (!isLoopbackHost(url.hostname)) {
    return url.origin;
  }

  const lanHost = localLanHost();
  if (!lanHost) {
    return url.origin;
  }

  url.hostname = lanHost;
  return url.origin;
}

export function buildGuestPassUrl(requestUrl: string, passId: string): string {
  const origin = guestPassOrigin(requestUrl);

  return `${origin.replace(/\/+$/, "")}/guest-pass/${encodeURIComponent(passId)}`;
}

export function normalizeGuestPassOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function buildGuestPassPreviewImageUrl(origin: string, shareToken: string): string {
  return `${normalizeGuestPassOrigin(origin)}/guest-pass/${encodeURIComponent(shareToken)}/preview-image`;
}

export type GuestPassShareStatus = {
  label: "Ready to scan" | "Unavailable" | "Already used" | "Expired";
  canRenderQr: boolean;
};

// Share-page labels for each derived pass status; the precedence itself lives
// in @emberly/core getGuestPassStatus.
const SHARE_STATUS_BY_PASS_STATUS: Record<PassStatus, GuestPassShareStatus> = {
  active: { label: "Ready to scan", canRenderQr: true },
  used: { label: "Already used", canRenderQr: false },
  expired: { label: "Expired", canRenderQr: false },
  revoked: { label: "Unavailable", canRenderQr: false },
};

export function getGuestPassShareStatus(
  pass: { status: "active" | "used" | "revoked"; usedAt: string | null; expiresAt: string },
  now = Date.now()
): GuestPassShareStatus {
  return SHARE_STATUS_BY_PASS_STATUS[getGuestPassStatus(pass, new Date(now))];
}

export type GuestPassPreviewDetails = {
  guestName: string;
  expiresAt: string;
  status: GuestPassShareStatus;
  unitId?: string | null;
};

export type GuestPassPreviewMetadata = {
  title: string;
  description: string;
};

export function formatGuestPassPreviewExpiration(iso: string): string {
  return formatShortDateTime(iso);
}

export function buildGuestPassPreviewMetadata(details: GuestPassPreviewDetails): GuestPassPreviewMetadata {
  const title = `${details.guestName} Guest Pass`;

  if (!details.status.canRenderQr) {
    return {
      title,
      description: `This Emberly guest pass is ${details.status.label.toLowerCase()}.`,
    };
  }

  const unitText = details.unitId ? ` for ${details.unitId}` : "";
  return {
    title,
    description: `Emberly guest access${unitText}. Expires ${formatGuestPassPreviewExpiration(details.expiresAt)}.`,
  };
}
