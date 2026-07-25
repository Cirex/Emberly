import type { PushRegistration } from "@/lib/push";

/**
 * Turns a failed push registration into something a technician can act on —
 * or into nothing, when there is nothing for them to do.
 *
 * WHY THIS EXISTS. Emergency dispatch was dead across the whole fleet and
 * nobody knew: the iOS build carried no `aps-environment` entitlement, so
 * getExpoPushTokenAsync threw on every launch, the throw hit a console.warn, and
 * push_tokens stayed empty while five technicians used the app daily. Same shape
 * as the dictation and translation failures — the bug was not the failure, it
 * was the SILENCE.
 *
 * Pure and separate from lib/push.ts so the copy is unit-testable without
 * expo-notifications. Same pattern as lib/dictation/availability-notice.ts and
 * lib/translation/availability-notice.ts.
 */

export interface PushNotice {
  title: string;
  body: string;
}

/**
 * `null` means stay quiet. Two cases earn silence:
 *   - `alerts_off` / `in_flight` — not failures at all.
 *   - `simulator` — a developer thing; a tech never sees it.
 *
 * Everything else gets said out loud, because the tech just asked for alerts and
 * would otherwise assume they now have them.
 */
export function emergencyAlertNotice(result: PushRegistration): PushNotice | null {
  if (result.ok) return null;

  switch (result.reason) {
    case "in_flight":
    case "alerts_off":
    case "simulator":
      return null;

    case "permission_denied":
      // The one case the tech can fix themselves, so say exactly where.
      return {
        title: "Notifications are turned off",
        body:
          "Emergency work orders can't reach this phone until notifications are allowed for Emberly. " +
          "Open Settings › Notifications › Emberly Maintenance and turn on Allow Notifications.",
      };

    case "no_push_entitlement":
    case "no_project_id":
      // A build-configuration problem. The tech can do nothing about it, so
      // don't imply they can — but don't pretend alerts are working either.
      return {
        title: "Emergency alerts aren't available in this build",
        body:
          "This copy of the app can't receive push notifications. Your alerts setting is saved, " +
          "but emergency work orders won't buzz this phone until an updated build is installed. " +
          "Let the office know.",
      };

    case "server_rejected":
      return {
        title: "Couldn't turn on emergency alerts",
        body:
          "The server didn't accept this device. Your setting is saved — it will try again next " +
          "time the app opens. Tell the office if alerts still don't arrive.",
      };

    case "unknown":
    default:
      return {
        title: "Couldn't turn on emergency alerts",
        body:
          "Something went wrong registering this phone. Your setting is saved and the app will " +
          "retry on next launch." + (result.detail ? `\n\n${result.detail}` : ""),
      };
  }
}
