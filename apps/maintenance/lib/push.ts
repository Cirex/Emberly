import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { capture } from "@/lib/analytics";
import { registerPushToken, unregisterPushToken } from "@/lib/api/push-tokens";
import { emergencyWorkOrderIdFrom } from "@/lib/push-routing";
import type { StaffConfig } from "@/lib/stores/config";
import { useSettings } from "@/lib/stores/settings";

/**
 * Emergency work-order push notifications. Registration ties this device's
 * Expo push token to the signed-in staff member via /api/admin/push-tokens;
 * the server fans emergency work orders out to every registered device.
 *
 * Every failure path here warns and returns — sign-in, sign-out, and the
 * settings toggle must never break because notifications couldn't.
 */

/** Android needs a channel before any push can be displayed (API 26+). */
const ANDROID_CHANNEL = "emergency";

// Session state: the token this session registered (so sign-out deletes the
// exact same one) and an in-flight latch making register idempotent — the
// sign-in screen and the tabs layout may both call it in quick succession.
let registeredToken: string | null = null;
let registering = false;

// Cold-start taps: getLastNotificationResponseAsync keeps returning the same
// response for the whole process lifetime, so remember what was handled.
let handledResponseDate: number | null = null;

/**
 * Why registration didn't happen. This used to be a `void` function whose every
 * failure path was a `console.warn`, and the cost of that was concrete: the iOS
 * push entitlement was missing from the build, `getExpoPushTokenAsync` threw on
 * every launch, and push_tokens stayed EMPTY for the whole fleet with no symptom
 * anyone could see. A reason code that reaches analytics makes the next such
 * outage a dashboard line instead of an archaeology exercise.
 */
export type PushRegistrationReason =
  /** A registration is already in flight this session. */
  | "in_flight"
  /** The tech turned emergency alerts off in Settings. */
  | "alerts_off"
  /** Simulator — Apple issues push tokens only to real hardware. */
  | "simulator"
  | "permission_denied"
  /** No EAS projectId in the app config. */
  | "no_project_id"
  /** iOS refused to register: the build has no `aps-environment` entitlement. */
  | "no_push_entitlement"
  | "server_rejected"
  | "unknown";

export type PushRegistration =
  | { ok: true; alreadyRegistered: boolean }
  | { ok: false; reason: PushRegistrationReason; detail?: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Last outcome, so Settings can show the tech why alerts aren't arriving. */
let lastRegistration: PushRegistration | null = null;

function report(result: PushRegistration): PushRegistration {
  lastRegistration = result;
  if (result.ok) {
    if (!result.alreadyRegistered) capture("push_registered");
    return result;
  }
  // `in_flight` is normal concurrency, not a failure worth reporting.
  if (result.reason !== "in_flight") {
    console.warn(`[push] not registered: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`);
    // No PII: a reason code and the platform.
    capture("push_registration_failed", { reason: result.reason, platform: Platform.OS });
  }
  return result;
}

function easProjectId(): string | null {
  const fromExtra: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
  const fromEas: unknown = Constants.easConfig?.projectId;
  if (typeof fromEas === "string" && fromEas.length > 0) return fromEas;
  return null;
}

async function ensureGranted(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  // Denied-and-final means asking again is a no-op; skip the prompt.
  if (!current.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

/**
 * Register this device for emergency pushes. Cheap and idempotent — callers
 * fire-and-forget it after sign-in, on app start, and from the settings
 * toggle. Skips silently when alerts are off, permission is denied, or the
 * app runs on a simulator (push tokens need real hardware).
 */
export async function registerForEmergencyPush(config: StaffConfig): Promise<PushRegistration> {
  if (registeredToken) return report({ ok: true, alreadyRegistered: true });
  if (registering) return report({ ok: false, reason: "in_flight" });
  registering = true;
  try {
    if (!useSettings.getState().emergencyAlerts) return report({ ok: false, reason: "alerts_off" });
    if (!Device.isDevice) return report({ ok: false, reason: "simulator" });
    if (!(await ensureGranted())) return report({ ok: false, reason: "permission_denied" });
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
        name: "Emergency work orders",
        importance: Notifications.AndroidImportance.MAX,
      });
    }
    const projectId = easProjectId();
    if (!projectId) return report({ ok: false, reason: "no_project_id" });

    let token: string;
    try {
      token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    } catch (error) {
      // The failure this whole reporting exists for. On iOS this throws when the
      // build carries no `aps-environment` entitlement — which is a BUILD
      // configuration problem, invisible at runtime, and it kept push_tokens
      // empty while real devices used the app every day.
      return report({ ok: false, reason: "no_push_entitlement", detail: message(error) });
    }

    const platform = Platform.OS === "ios" ? "ios" : "android";
    if (!(await registerPushToken({ token, platform }, config))) {
      return report({ ok: false, reason: "server_rejected" });
    }
    registeredToken = token;
    return report({ ok: true, alreadyRegistered: false });
  } catch (error) {
    return report({ ok: false, reason: "unknown", detail: message(error) });
  } finally {
    registering = false;
  }
}

/**
 * Stop emergency pushes for this device. Called on sign-out (while the token
 * still authenticates) and when the settings toggle turns off. Falls back to
 * re-deriving the Expo token when this process never registered one (app
 * restarted since sign-in); the DELETE is idempotent server-side.
 */
export async function unregisterEmergencyPush(config: StaffConfig): Promise<void> {
  try {
    const token = registeredToken ?? (await currentExpoToken());
    if (token) await unregisterPushToken({ token }, config);
  } catch (error) {
    console.warn("[push] unregister failed:", error);
  } finally {
    // Always forget: a later toggle-on / sign-in must register fresh.
    registeredToken = null;
  }
}

/** The device's current Expo token, only if permission is already granted. */
async function currentExpoToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  const projectId = easProjectId();
  if (!projectId) return null;
  if (!(await Notifications.getPermissionsAsync()).granted) return null;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

function openWorkOrderFrom(response: Notifications.NotificationResponse | null): void {
  const id = emergencyWorkOrderIdFrom(response?.notification.request.content.data);
  if (!id) return;
  const receivedAt = response?.notification.date ?? 0;
  if (handledResponseDate === receivedAt) return;
  handledResponseDate = receivedAt;
  // Past the dedupe latch, so a cold-start replay can't double-report.
  capture("emergency_push_opened");
  router.push({ pathname: "/work-order/[id]", params: { id } });
}

/**
 * Root-layout hook: shows emergency alerts while the app is foregrounded and
 * routes notification taps to the work order they announce. `enabled` gates
 * the cold-start replay until the layout has hydrated and mounted the
 * protected routes — pushing earlier would navigate before the stack exists.
 */
export function useEmergencyNotificationResponses(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    // Foreground presentation: without a handler iOS swallows pushes while the
    // app is open, which is exactly when an emergency must interrupt.
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        // Silent sync wake-ups carry no user-visible content and must not be
        // presented — banner-ing "the board changed" every few minutes is
        // exactly how a tech learns to swipe our notifications away, emergency
        // ones included.
        if (isWorkOrdersChanged(notification)) {
          return {
            shouldShowBanner: false,
            shouldShowList: false,
            shouldPlaySound: false,
            shouldSetBadge: false,
          };
        }
        return {
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        };
      },
    });
    // Warm taps (app foregrounded or backgrounded) arrive via the listener…
    const subscription = Notifications.addNotificationResponseReceivedListener(openWorkOrderFrom);
    // …while a tap that launched a killed app is replayed from here.
    Notifications.getLastNotificationResponseAsync()
      .then(openWorkOrderFrom)
      .catch((error) => console.warn("[push] cold-start response read failed:", error));
    return () => subscription.remove();
  }, [enabled]);
}

/** `data.type` the sync worker stamps on its silent wake-up pushes. */
export const WORK_ORDERS_CHANGED = "work-orders-changed";

/** True when this notification is a sync wake-up rather than an alert. */
function isWorkOrdersChanged(notification: Notifications.Notification): boolean {
  return notification.request.content.data?.type === WORK_ORDERS_CHANGED;
}

/**
 * Run `onChanged` when the server says the work-order mirror moved.
 *
 * This is what makes the app feel live rather than polled: the sync worker
 * pushes a silent, content-free notification the moment it writes a real
 * change, and the device runs the sync tick it already had. The interval poll
 * stays as the floor — push is best-effort by nature (a tech can decline the
 * permission, and iOS throttles silent delivery), so it must never be the only
 * way data arrives.
 *
 * Foreground and backgrounded delivery only. A push to a KILLED app needs a
 * registered background task; until then the next launch's tick covers it.
 */
export function useWorkOrdersChangedPush(enabled: boolean, onChanged: () => void): void {
  const handler = useRef(onChanged);
  handler.current = onChanged;

  useEffect(() => {
    if (!enabled) return;
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      if (isWorkOrdersChanged(notification)) handler.current();
    });
    return () => subscription.remove();
  }, [enabled]);
}
