import { Resend, type CreateEmailOptions } from "resend";
import { format } from "date-fns";

const FROM_ADDRESS =
  process.env.RESEND_FROM_EMAIL ?? "Emberly Guest Passes <guest-passes@notifications.emberlyapartments.com>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://emberly.krkn.app";

let resendClient: Resend | null = null;

function getResendClient(): Resend {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY environment variable");
  }

  resendClient ??= new Resend(apiKey);
  return resendClient;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeSubject(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function getSenderDomain(fromAddress: string): string | null {
  const emailMatch = fromAddress.match(/<([^<>@\s]+@[^<>@\s]+)>/) ?? fromAddress.match(/([^<>@\s]+@[^<>@\s]+)/);
  return emailMatch?.[1]?.split("@")[1]?.toLowerCase() ?? null;
}

function getEmailOrigin(): string {
  const configuredOrigin = process.env.GUEST_PASS_EMAIL_ORIGIN?.trim();
  if (configuredOrigin) {
    return configuredOrigin.replace(/\/+$/, "");
  }

  const senderDomain = getSenderDomain(FROM_ADDRESS);
  return senderDomain ? `https://${senderDomain}` : APP_URL.replace(/\/+$/, "");
}

interface GuestPassEmailParams {
  guestName: string;
  guestEmail: string;
  residentName: string;
  unitAddress: string;
  propertyName: string;
  shareUrl: string;
  expiresAt: Date;
  passId: string;
}

function buildEmailUrl(urlOrPath: string): string {
  const emailOrigin = getEmailOrigin();

  try {
    const originalUrl = new URL(urlOrPath, emailOrigin);
    return new URL(`${originalUrl.pathname}${originalUrl.search}${originalUrl.hash}`, emailOrigin).toString();
  } catch {
    return urlOrPath;
  }
}

function sanitizeTagValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 256) || "unknown";
}

export function buildGuestPassEmailPayload(params: GuestPassEmailParams): CreateEmailOptions {
  const {
    guestName,
    guestEmail,
    residentName,
    unitAddress,
    propertyName,
    shareUrl,
    expiresAt,
    passId,
  } = params;

  const expiryFormatted = format(expiresAt, "EEEE, MMMM d 'at' h:mm a");
  const expiryShort = format(expiresAt, "MMM d 'at' h:mm a");
  const safeGuestName = escapeHtml(guestName);
  const safeResidentName = escapeHtml(residentName);
  const safeUnitAddress = escapeHtml(unitAddress);
  const safePropertyName = escapeHtml(propertyName);
  const emailShareUrl = buildEmailUrl(shareUrl);
  const safeShareUrl = escapeHtml(emailShareUrl);
  const safeLogoUrl = escapeHtml(buildEmailUrl("/logo-flower-transparent.png"));
  const subjectPropertyName = sanitizeSubject(propertyName);
  const safeEntityRef = sanitizeTagValue(passId);

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Emberly Guest Pass</title>
</head>
<body style="margin:0;padding:0;background:#F5F1E6;color:#17205C;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;color:transparent;opacity:0;">
    ${safeResidentName} sent you a 24-hour guest pass for ${safePropertyName}.
  </div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F5F1E6;border-collapse:collapse;width:100%;">
    <tr>
      <td align="center" style="padding:36px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#FFFFFF;border:1px solid #E0E3F0;border-collapse:separate;border-radius:28px;box-shadow:0 18px 48px rgba(38,52,138,0.14);max-width:640px;overflow:hidden;width:100%;">
          <tr>
            <td align="center" style="padding:38px 30px 28px;">
              <img src="${safeLogoUrl}" width="72" height="72" alt="" style="border:0;display:block;height:72px;margin:0 auto 18px;width:72px;" />
              <div style="color:#26348A;font-family:Georgia,'Times New Roman',serif;font-size:40px;font-weight:400;letter-spacing:9px;line-height:1;margin:0;">EMBERLY</div>
              <div style="color:#26348A;font-size:15px;font-weight:600;letter-spacing:7px;margin:10px 0 30px;">APARTMENTS</div>
              <div style="color:#B4B53A;font-size:12px;font-weight:800;letter-spacing:1.6px;margin:0 0 12px;text-transform:uppercase;">Guest Pass</div>
              <h1 style="color:#26348A;font-size:32px;line-height:1.15;margin:0;">You're Invited</h1>
              <p style="color:#6F748C;font-size:17px;line-height:1.55;margin:14px auto 0;max-width:460px;">
                ${safeResidentName} created a single-use guest pass for your visit. Open the pass when you arrive and present the QR code at the gate.
              </p>
            </td>
          </tr>
          <tr>
            <td style="border-top:1px solid rgba(38,52,138,0.14);padding:30px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#FFFFFF;border:1px solid #E0E3F0;border-collapse:separate;border-radius:22px;width:100%;">
                <tr>
                  <td style="border-bottom:1px solid #E7E9F3;color:#6F748C;font-size:14px;font-weight:600;padding:15px 20px;">Guest</td>
                  <td align="right" style="border-bottom:1px solid #E7E9F3;color:#17205C;font-size:15px;font-weight:700;padding:15px 20px;">${safeGuestName}</td>
                </tr>
                <tr>
                  <td style="border-bottom:1px solid #E7E9F3;color:#6F748C;font-size:14px;font-weight:600;padding:15px 20px;">Resident</td>
                  <td align="right" style="border-bottom:1px solid #E7E9F3;color:#17205C;font-size:15px;font-weight:700;padding:15px 20px;">${safeResidentName}</td>
                </tr>
                <tr>
                  <td style="border-bottom:1px solid #E7E9F3;color:#6F748C;font-size:14px;font-weight:600;padding:15px 20px;">Unit</td>
                  <td align="right" style="border-bottom:1px solid #E7E9F3;color:#17205C;font-size:15px;font-weight:700;padding:15px 20px;">${safeUnitAddress}</td>
                </tr>
                <tr>
                  <td style="color:#6F748C;font-size:14px;font-weight:600;padding:15px 20px;">Expires</td>
                  <td align="right" style="color:#17205C;font-size:15px;font-weight:700;padding:15px 20px;">${escapeHtml(expiryShort)}</td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;">
                <tr>
                  <td align="center" style="padding:28px 0 10px;">
                    <a href="${safeShareUrl}" style="background:#B4B53A;border-radius:18px;color:#FFFFFF;display:inline-block;font-size:18px;font-weight:800;min-width:240px;padding:16px 24px;text-align:center;text-decoration:none;">View Guest Pass</a>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:18px;width:100%;">
                <tr>
                  <td valign="top" width="54" style="padding:0 14px 0 0;">
                    <div style="background:#FFFFFF;border:1px solid #E7E9F3;border-radius:999px;color:#B4B53A;font-size:24px;height:46px;line-height:46px;text-align:center;width:46px;">i</div>
                  </td>
                  <td style="color:#6F748C;font-size:14px;line-height:1.55;padding:3px 0 0;">
                    This pass is single-use and expires after 24 hours. Do not forward this email unless the resident asks you to.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="color:#7C829B;font-size:12px;line-height:1.6;padding:0 28px 30px;">
              Sent by Emberly Apartments from guest-passes@notifications.emberlyapartments.com<br />
              If you were not expecting this pass, contact the resident or property manager.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const text = `
Your Emberly Guest Pass

Hi ${guestName},

${residentName} has invited you to visit ${unitAddress} at ${propertyName}.

View your guest pass:
${emailShareUrl}

Open the pass when you arrive and present the QR code at the gate. This pass is valid for one use only and expires on ${expiryFormatted}.

Do not share this email. If you did not expect this message, please ignore it.
  `.trim();

  return {
    from: FROM_ADDRESS,
    to: guestEmail,
    subject: `Your Emberly guest pass - ${sanitizeSubject(subjectPropertyName || propertyName)}`,
    html,
    text,
    headers: {
      "X-Entity-Ref-ID": safeEntityRef,
    },
    tags: [
      { name: "type", value: "guest_pass" },
      { name: "pass_id", value: safeEntityRef },
    ],
  };
}

/**
 * Sends a guest pass email with a link to the pass page.
 */
export async function sendGuestPassEmail(params: GuestPassEmailParams): Promise<{ id: string }> {
  const { data, error } = await getResendClient().emails.send({
    ...buildGuestPassEmailPayload(params),
  });

  if (error || !data) {
    throw new Error(`Failed to send guest pass email: ${error?.message ?? "Unknown error"}`);
  }

  return { id: data.id };
}
