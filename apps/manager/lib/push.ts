import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { capture } from "@/lib/analytics";
import { registerPushToken, unregisterPushToken } from "@/lib/api/push-tokens";
import { managerPushTargetFrom } from "@/lib/push-routing";
import type { StaffConfig } from "@/lib/stores/config";
import { enabledAlertKinds, useSettings } from "@/lib/stores/settings";

/**
 * Manager alert push notifications. Registration ties this device's Expo push
 * token to the signed-in staff member via /api/admin/push-tokens; the sync
 * worker's manager-alerts job fans the seven alert kinds out to every
 * registered MANAGER device (push_tokens.app = 'manager' — the maintenance
 * app's emergency work orders never reach these phones, and vice versa).
 *
 * The per-kind settings toggles ride along as `alertKinds` so the SERVER
 * decides what to send. Client-side filtering was rejected: the OS presents a
 * push that arrives while the app is backgrounded before any of our code can
 * inspect it, so a muted kind would still buzz the phone.
 *
 * Every failure path here warns, reports `push_registration_failed`, and
 * returns — sign-in, sign-out, and the settings toggles must never break
 * because notifications couldn't.
 */

/** Android needs a channel before any push can be displayed (API 26+). */
const ANDROID_CHANNEL = "manager-alerts";

// Session state: the token this session registered (so sign-out deletes the
// exact same one) and an in-flight latch making register idempotent — the root
// layout and the settings toggles may both call it in quick succession.
let registeredToken: string | null = null;
let registering = false;

// Cold-start taps: getLastNotificationResponseAsync keeps returning the same
// response for the whole process lifetime, so remember what was handled.
let handledResponseDate: number | null = null;

function easProjectId(): string | null {
  const fromExtra: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
  const fromEas: unknown = Constants.easConfig?.projectId;
  if (typeof fromEas === "string" && fromEas.length > 0) return fromEas;
  return null;
}

/** Report why registration stopped. Inert when analytics is disabled. */
function reportFailure(reason: string): void {
  capture("push_registration_failed", { reason });
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
 * Register this device for manager alerts. Cheap and idempotent — callers
 * fire-and-forget it after sign-in, on app start, and from the settings
 * toggles. Skips silently when every alert kind is off, permission is denied,
 * or the app runs on a simulator (push tokens need real hardware).
 *
 * `force` re-registers even when this session already has a token — the
 * settings toggles use it to push a changed `alertKinds` list to the server.
 */
export async function registerForManagerPush(
  config: StaffConfig,
  options: { force?: boolean } = {},
): Promise<void> {
  if (registering) return;
  if (registeredToken && !options.force) return;
  registering = true;
  try {
    const alertKinds = enabledAlertKinds(useSettings.getState().alerts);
    if (alertKinds.length === 0) {
      reportFailure("alerts_off");
      return;
    }
    if (!Device.isDevice) {
      reportFailure("simulator");
      return;
    }
    if (!(await ensureGranted())) {
      reportFailure("permission_denied");
      return;
    }
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
        name: "Manager alerts",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    const projectId = easProjectId();
    if (!projectId) {
      console.warn("[push] no EAS projectId in app config; skipping registration");
      reportFailure("no_project_id");
      return;
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    const platform = Platform.OS === "ios" ? "ios" : "android";
    if (await registerPushToken({ token, platform, alertKinds }, config)) {
      registeredToken = token;
    } else {
      console.warn("[push] token registration was not accepted by the server");
      reportFailure("server_rejected");
    }
  } catch (error) {
    console.warn("[push] registration failed:", error);
    reportFailure("exception");
  } finally {
    registering = false;
  }
}

/**
 * Stop manager alerts for this device. Called on sign-out (while the token
 * still authenticates) and when the last alert toggle turns off. Falls back to
 * re-deriving the Expo token when this process never registered one (app
 * restarted since sign-in); the DELETE is idempotent server-side.
 */
export async function unregisterManagerPush(config: StaffConfig): Promise<void> {
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

/**
 * Push the current toggle state to the server: re-register when at least one
 * kind is on, unregister when the manager has switched them all off. The
 * settings screen calls this after every toggle.
 */
export async function syncManagerPushRegistration(config: StaffConfig): Promise<void> {
  const alertKinds = enabledAlertKinds(useSettings.getState().alerts);
  if (alertKinds.length === 0) {
    await unregisterManagerPush(config);
    return;
  }
  await registerForManagerPush(config, { force: true });
}

/** The device's current Expo token, only if permission is already granted. */
async function currentExpoToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  const projectId = easProjectId();
  if (!projectId) return null;
  if (!(await Notifications.getPermissionsAsync()).granted) return null;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

function openAlertFrom(response: Notifications.NotificationResponse | null): void {
  const target = managerPushTargetFrom(response?.notification.request.content.data);
  if (!target) return;
  const receivedAt = response?.notification.date ?? 0;
  if (handledResponseDate === receivedAt) return;
  handledResponseDate = receivedAt;
  // Past the dedupe latch, so a cold-start replay can't double-report.
  capture("manager_alert_opened", { kind: target.kind });
  router.push(target.route);
}

/**
 * Root-layout hook: shows manager alerts while the app is foregrounded and
 * routes notification taps to the tab they announce. `enabled` gates the
 * cold-start replay until the layout has hydrated and mounted the protected
 * routes — pushing earlier would navigate before the stack exists.
 */
export function useManagerNotificationResponses(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    // Foreground presentation: without a handler iOS swallows pushes while the
    // app is open, which is when a manager is most likely to act on one.
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    // Warm taps (app foregrounded or backgrounded) arrive via the listener…
    const subscription = Notifications.addNotificationResponseReceivedListener(openAlertFrom);
    // …while a tap that launched a killed app is replayed from here.
    Notifications.getLastNotificationResponseAsync()
      .then(openAlertFrom)
      .catch((error) => console.warn("[push] cold-start response read failed:", error));
    return () => subscription.remove();
  }, [enabled]);
}
