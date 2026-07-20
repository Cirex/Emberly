import type { SupabaseClient } from "@supabase/supabase-js";
import { sendGuestPassEmail } from "@/lib/email";
import { buildGuestPassUrl } from "@/lib/guest-pass-share";
import { EMBERLY_PROPERTY_NAME } from "@/lib/property";
import type { Database } from "@/types/database";

type GuestPassEmailPass = {
  id: string;
  share_token: string;
  guest_name: string;
  guest_email: string;
  expires_at: string;
};

type GuestPassEmailResident = {
  name: string;
  unit_id: string;
};

export async function sendGuestPassEmailForPass({
  requestUrl,
  pass,
  resident,
}: {
  requestUrl: string;
  pass: GuestPassEmailPass;
  resident: GuestPassEmailResident;
}): Promise<{ shareUrl: string; emailId: string }> {
  const shareUrl = buildGuestPassUrl(requestUrl, pass.share_token);

  const email = await sendGuestPassEmail({
    guestName: pass.guest_name,
    guestEmail: pass.guest_email,
    residentName: resident.name,
    unitAddress: resident.unit_id,
    propertyName: EMBERLY_PROPERTY_NAME,
    shareUrl,
    expiresAt: new Date(pass.expires_at),
    passId: pass.id,
  });

  return { shareUrl, emailId: email.id };
}

function emailErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sends the guest pass email and records the delivery outcome on the
 * guest_passes row (email_delivery_status / email_provider_id /
 * email_sent_at / email_last_error). Bookkeeping failures are logged but
 * never override the delivery outcome.
 */
export async function sendAndRecordGuestPassEmail({
  supabase,
  requestUrl,
  pass,
  resident,
  logPrefix,
}: {
  supabase: SupabaseClient<Database>;
  requestUrl: string;
  pass: GuestPassEmailPass;
  resident: GuestPassEmailResident;
  logPrefix: string;
}): Promise<{ sent: true; shareUrl: string } | { sent: false }> {
  try {
    const email = await sendGuestPassEmailForPass({ requestUrl, pass, resident });
    const { error: updateError } = await supabase
      .from("guest_passes")
      .update({
        email_delivery_status: "sent",
        email_provider_id: email.emailId,
        email_sent_at: new Date().toISOString(),
        email_last_error: null,
      })
      .eq("id", pass.id);
    if (updateError) {
      console.error(`${logPrefix} Failed to record email delivery:`, updateError);
    }
    return { sent: true, shareUrl: email.shareUrl };
  } catch (emailErr) {
    console.error(`${logPrefix} Email send failed:`, emailErr);
    const { error: updateError } = await supabase
      .from("guest_passes")
      .update({
        email_delivery_status: "failed",
        email_last_error: emailErrorMessage(emailErr).slice(0, 1000),
      })
      .eq("id", pass.id);
    if (updateError) {
      console.error(`${logPrefix} Failed to record email failure:`, updateError);
    }
    return { sent: false };
  }
}
