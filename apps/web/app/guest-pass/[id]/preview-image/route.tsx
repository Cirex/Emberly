import { ImageResponse } from "next/og";
import { formatShortDateTime } from "@emberly/core";
import { getGuestPassShareStatus } from "@/lib/guest-pass-share";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type GuestPassPreviewRecord = {
  guest_name: string;
  expires_at: string;
  used_at: string | null;
  status: "active" | "used" | "revoked";
};

interface GuestPassPreviewImageProps {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: GuestPassPreviewImageProps) {
  const { id } = await params;
  const supabase = createAdminClient();
  const { data: pass, error } = await supabase
    .from("guest_passes")
    .select("guest_name, expires_at, used_at, status")
    .eq("share_token", id)
    .maybeSingle();

  if (error || !pass) {
    return new Response("Not found", { status: 404 });
  }

  const guestPass = pass as GuestPassPreviewRecord;
  const status = getGuestPassShareStatus({
    status: guestPass.status,
    usedAt: guestPass.used_at,
    expiresAt: guestPass.expires_at,
  });
  const statusLabel = status.canRenderQr ? "Ready" : status.label;
  const logoUrl = new URL("/logo-flower.jpg", request.url).toString();

  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "linear-gradient(135deg, #F8F5EC 0%, #FFFFFF 48%, #EEF1DA 100%)",
          color: "#12216D",
          display: "flex",
          fontFamily: "Arial, Helvetica, sans-serif",
          height: "100%",
          justifyContent: "center",
          padding: 72,
          width: "100%",
        }}
      >
        <div
          style={{
            background: "rgba(255, 255, 255, 0.78)",
            border: "2px solid rgba(255, 255, 255, 0.9)",
            borderRadius: 42,
            boxShadow: "0 24px 80px rgba(18, 33, 109, 0.16)",
            display: "flex",
            flexDirection: "column",
            height: "100%",
            justifyContent: "space-between",
            padding: 48,
            width: "100%",
          }}
        >
          <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
            <div style={{ alignItems: "center", display: "flex", gap: 28 }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- next/og ImageResponse renders image assets with img tags. */}
              <img
                src={logoUrl}
                alt=""
                style={{
                  display: "flex",
                  height: 88,
                  objectFit: "contain",
                  width: 88,
                }}
              />
              <div style={{ color: "#6E7390", display: "flex", fontSize: 30, fontWeight: 700 }}>
                EMBERLY APARTMENTS
              </div>
            </div>
            <div
              style={{
                border: "2px solid #B4B53A",
                borderRadius: 999,
                color: "#81860D",
                display: "flex",
                fontSize: 34,
                fontWeight: 700,
                padding: "16px 28px",
              }}
            >
              {statusLabel}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ color: "#12216D", display: "flex", fontSize: 84, fontWeight: 760 }}>
              {guestPass.guest_name}
            </div>
            <div style={{ color: "#6E7390", display: "flex", fontSize: 42, fontWeight: 650 }}>
              Guest Pass
            </div>
          </div>

          <div style={{ background: "rgba(18, 33, 109, 0.12)", display: "flex", height: 3, width: "100%" }} />

          <div
            style={{
              alignItems: "flex-end",
              color: "#12216D",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", fontSize: 38, fontWeight: 760 }}>
                Expires {formatShortDateTime(guestPass.expires_at)}
              </div>
              <div style={{ color: "#81860D", display: "flex", fontSize: 32, fontWeight: 760 }}>
                Tap to view QR code
              </div>
            </div>
            <div style={{ color: "#6E7390", display: "flex", fontSize: 30, fontWeight: 650 }}>
              Single-use access
            </div>
          </div>
        </div>
      </div>
    ),
    {
      height: 630,
      width: 1200,
    }
  );
}
