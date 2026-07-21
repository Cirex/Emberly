import { formatShortDateTime, getGuestPassStatus } from '@emberly/core';

export interface GuestPass {
  passId: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  guestAddress: string;
  qrData: string;
  shareUrl?: string;
  createdAt: string;
  expiresAt: string;
  status: "active" | "used" | "expired" | "revoked";
  used: boolean;
  usedAt?: string;
}

export type ApiGuestPass = {
  id?: string;
  passId?: string;
  guest_name?: string;
  guestName?: string;
  guest_email?: string;
  guestEmail?: string;
  guest_phone?: string | null;
  guestPhone?: string;
  guest_address?: string | null;
  guestAddress?: string;
  qrData?: string;
  share_url?: string;
  shareUrl?: string;
  created_at?: string;
  createdAt?: string;
  expires_at?: string;
  expiresAt?: string;
  status?: "active" | "used" | "expired" | "revoked";
  used_at?: string | null;
  usedAt?: string;
  used?: boolean;
};

type CreatedGuestPassResponse = {
  pass: ApiGuestPass;
  warning?: string;
};

type GuestPassesResponse = { passes?: ApiGuestPass[] };

export function normalizeGuestPassesResponse(response: GuestPassesResponse, now: Date = new Date()): GuestPass[] {
  return (response.passes ?? []).map((pass) => normalizeGuestPass(pass, now));
}

function normalizeGuestPass(pass: ApiGuestPass, now: Date = new Date()): GuestPass {
  const shareUrl = pass.shareUrl ?? pass.share_url ?? undefined;
  const qrData = pass.qrData?.trim() || shareUrl || "";
  const used = pass.used ?? (pass.status === "used" || Boolean(pass.used_at ?? pass.usedAt));
  const expiresAt = pass.expiresAt ?? pass.expires_at ?? "";
  // Same precedence the server uses (revoked > used > expired > active),
  // via the shared implementation. The locally resolved `used` flag is passed
  // instead of the raw timestamps so an explicit `used: false` wins.
  const status: GuestPass["status"] = getGuestPassStatus(
    { status: pass.status, used, expiresAt },
    now
  );

  return {
    passId: pass.passId ?? pass.id ?? "",
    guestName: pass.guestName ?? pass.guest_name ?? "",
    guestEmail: pass.guestEmail ?? pass.guest_email ?? "",
    guestPhone: pass.guestPhone ?? pass.guest_phone ?? "",
    guestAddress: pass.guestAddress ?? pass.guest_address ?? "",
    qrData,
    ...(shareUrl ? { shareUrl } : {}),
    createdAt: pass.createdAt ?? pass.created_at ?? "",
    expiresAt,
    status,
    used,
    usedAt: pass.usedAt ?? pass.used_at ?? undefined,
  };
}

export function normalizeCreatedGuestPassResponse(
  response: CreatedGuestPassResponse,
  now: Date = new Date()
): GuestPass {
  return normalizeGuestPass(response.pass, now);
}

export function upsertGuestPass(passes: GuestPass[], pass: GuestPass): GuestPass[] {
  return [pass, ...passes.filter((item) => item.passId !== pass.passId)];
}

export function buildGuestPassShareMessage(pass: Pick<GuestPass, "guestName" | "shareUrl" | "qrData" | "expiresAt">): string {
  const passLocation = pass.shareUrl ?? pass.qrData;
  const expires = pass.expiresAt ? formatShortDateTime(pass.expiresAt) : "soon";

  return `${pass.guestName}, here is your Emberly guest pass:\n\n${passLocation}\n\nShow the QR code from this page at the entrance. This pass expires ${expires}.`;
}
