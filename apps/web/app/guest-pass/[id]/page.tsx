import QRCode from "qrcode";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Image from "next/image";
import { notFound } from "next/navigation";
import { formatShortDateTime } from "@emberly/core";
import { createGuestEntryToken } from "@/lib/auth";
import {
  DEFAULT_PUBLIC_GUEST_PASS_ORIGIN,
  buildGuestPassPreviewImageUrl,
  buildGuestPassPreviewMetadata,
  getGuestPassShareStatus,
  normalizeGuestPassOrigin,
} from "@/lib/guest-pass-share";
import { EMBERLY_PROPERTY_NAME } from "@/lib/property";
import { createAdminClient } from "@/lib/supabase/admin";

interface GuestPassPageProps {
  params: Promise<{ id: string }>;
}

type GuestPassPageRecord = {
  id: string;
  guest_name: string;
  expires_at: string;
  used_at: string | null;
  status: "active" | "used" | "revoked";
  residents:
    | {
        unit_id: string | null;
      }
    | Array<{
        unit_id: string | null;
      }>
    | null;
};

function createGuestPassPageQrData(passId: string, expiresAt: string): string {
  return createGuestEntryToken(
    { guestPassId: passId },
    { ttlMs: Math.max(0, Date.parse(expiresAt) - Date.now()) }
  );
}

async function getGuestPassByShareToken(shareToken: string): Promise<GuestPassPageRecord | null> {
  const supabase = createAdminClient();
  const { data: pass, error } = await supabase
    .from("guest_passes")
    .select("id, guest_name, expires_at, used_at, status, residents(unit_id)")
    .eq("share_token", shareToken)
    .maybeSingle();

  if (error || !pass) {
    return null;
  }

  return pass as GuestPassPageRecord;
}

async function getPublicGuestPassOrigin(): Promise<string> {
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (process.env.NODE_ENV === "production" && configuredUrl) {
    return normalizeGuestPassOrigin(configuredUrl);
  }

  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  if (host) {
    const protocol =
      headerList.get("x-forwarded-proto") ??
      (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${protocol}://${host}`;
  }

  return normalizeGuestPassOrigin(configuredUrl || DEFAULT_PUBLIC_GUEST_PASS_ORIGIN);
}

function getResidentUnitId(pass: GuestPassPageRecord): string | null {
  const resident = Array.isArray(pass.residents) ? pass.residents[0] : pass.residents;
  return resident?.unit_id ?? null;
}

export async function generateMetadata({ params }: GuestPassPageProps): Promise<Metadata> {
  const { id } = await params;
  const pass = await getGuestPassByShareToken(id);

  if (!pass) {
    return {
      title: "Guest Pass Not Found",
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  const origin = await getPublicGuestPassOrigin();
  const status = getGuestPassShareStatus({
    status: pass.status,
    usedAt: pass.used_at,
    expiresAt: pass.expires_at,
  });
  const preview = buildGuestPassPreviewMetadata({
    guestName: pass.guest_name,
    expiresAt: pass.expires_at,
    status,
    unitId: getResidentUnitId(pass),
  });
  const url = `${origin}/guest-pass/${encodeURIComponent(id)}`;
  const imageUrl = buildGuestPassPreviewImageUrl(origin, id);

  return {
    title: preview.title,
    description: preview.description,
    robots: {
      index: false,
      follow: false,
    },
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: preview.title,
      description: preview.description,
      url,
      siteName: "Emberly Apartments",
      type: "website",
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: preview.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: preview.title,
      description: preview.description,
      images: [imageUrl],
    },
  };
}

export default async function GuestPassPage({ params }: GuestPassPageProps) {
  const { id } = await params;
  const pass = await getGuestPassByShareToken(id);

  if (!pass) {
    notFound();
  }

  const status = getGuestPassShareStatus({
    status: pass.status,
    usedAt: pass.used_at,
    expiresAt: pass.expires_at,
  });
  const qrDataUrl = status.canRenderQr
    ? await QRCode.toDataURL(createGuestPassPageQrData(pass.id, pass.expires_at), {
      errorCorrectionLevel: "H",
      width: 520,
      margin: 2,
      color: {
        dark: "#26348A",
        light: "#FFFFFF",
      },
    })
    : null;
  const unitId = getResidentUnitId(pass);

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <div style={styles.brand}>EMBERLY PASS</div>
        <div style={styles.status}>{status.label}</div>
        {qrDataUrl ? (
          <div style={styles.qrFrame}>
            <Image
              src={qrDataUrl}
              alt="Guest pass QR code"
              width={300}
              height={300}
              unoptimized
              style={styles.qr}
            />
            <div style={styles.qrLogoShell} aria-hidden="true">
              <Image
                src="/logo-flower-transparent.png"
                alt=""
                width={54}
                height={54}
                unoptimized
                style={styles.qrLogo}
              />
            </div>
          </div>
        ) : (
          <div style={styles.inactiveQr}>QR unavailable</div>
        )}
        <h1 style={styles.name}>{pass.guest_name}</h1>
        <p style={styles.detail}>{EMBERLY_PROPERTY_NAME}</p>
        <p style={styles.detail}>{unitId ?? "Resident guest pass"}</p>
        <p style={styles.expiry}>Expires {formatShortDateTime(pass.expires_at)}</p>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#F4F1E6",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    fontFamily: "Arial, Helvetica, sans-serif",
  },
  card: {
    width: "100%",
    maxWidth: 420,
    background: "#FFFFFF",
    border: "1px solid #DDE1F0",
    borderRadius: 8,
    padding: 24,
    textAlign: "center",
    boxShadow: "0 8px 30px rgba(38, 52, 138, 0.10)",
  },
  brand: {
    color: "#26348A",
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: 0,
    marginBottom: 8,
  },
  status: {
    display: "inline-block",
    color: "#26348A",
    background: "#F4F1E6",
    border: "1px solid #B4B53A",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 14,
    fontWeight: 700,
    marginBottom: 18,
  },
  qr: {
    boxSizing: "border-box",
    display: "block",
    width: "100%",
    maxWidth: 300,
    margin: "0 auto",
    border: "2px solid #B4B53A",
    borderRadius: 8,
    padding: 12,
    background: "#FFFFFF",
  },
  qrFrame: {
    position: "relative",
    width: "100%",
    maxWidth: 300,
    margin: "0 auto",
  },
  qrLogoShell: {
    alignItems: "center",
    background: "#FFFFFF",
    borderRadius: 12,
    display: "flex",
    height: 66,
    justifyContent: "center",
    left: "50%",
    padding: 6,
    position: "absolute",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: 66,
  },
  qrLogo: {
    display: "block",
    height: 54,
    width: 54,
  },
  inactiveQr: {
    alignItems: "center",
    background: "#F4F1E6",
    border: "2px dashed #B4B53A",
    borderRadius: 8,
    color: "#26348A",
    display: "flex",
    fontSize: 16,
    fontWeight: 700,
    height: 300,
    justifyContent: "center",
    margin: "0 auto",
    maxWidth: 300,
    width: "100%",
  },
  name: {
    color: "#1B255F",
    fontSize: 24,
    margin: "18px 0 8px",
  },
  detail: {
    color: "#6A6F8A",
    fontSize: 15,
    margin: "4px 0",
  },
  expiry: {
    color: "#1B255F",
    fontSize: 15,
    fontWeight: 700,
    marginTop: 16,
  },
};
