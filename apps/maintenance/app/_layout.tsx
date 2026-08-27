// Imported FIRST: this module self-initializes Sentry on import, so crash
// reporting is armed before any other module's native side-effects run.
import { Sentry, sentryEnabled } from "@/lib/sentry";

// i18next must initialize before any component calls useTranslation.
import "@/lib/i18n";

import "../global.css";

import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme, vars } from "nativewind";
import { PropsWithChildren, useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PostHogProvider } from "posthog-react-native";
import { WorkspaceBackdrop } from "@/components/ui/WorkspaceBackdrop";
import { posthog } from "@/lib/analytics";
import { useEmergencyNotificationResponses } from "@/lib/push";
import { useResManSession } from "@/lib/resman/session";
import { isSignedIn, useConfig } from "@/lib/stores/config";
import { useSettings } from "@/lib/stores/settings";
import { accentVars } from "@/theme/tokens";

// Wrap the app in PostHogProvider only when a client exists (key configured);
// otherwise render children untouched so analytics stays fully inert.
function AnalyticsProvider({ children }: PropsWithChildren) {
  if (!posthog) return <>{children}</>;
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}

/**
 * The navigator paints its theme's `colors.background` across the whole
 * navigation container, which would hide the WorkspaceBackdrop completely.
 * Making it transparent is what lets the backdrop show at all.
 */
const TRANSPARENT_NAV = {
  light: { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: "transparent" } },
  dark: { ...DarkTheme, colors: { ...DarkTheme.colors, background: "transparent" } },
} as const;

function RootLayout() {
  const themePreference = useSettings((s) => s.themePreference);
  const fieldMode = useSettings((s) => s.fieldMode);
  const accentId = useSettings((s) => s.accentId);
  const { colorScheme, setColorScheme } = useColorScheme();
  const hydrated = useConfig((s) => s.hydrated);
  const hydrate = useConfig((s) => s.hydrate);
  const token = useConfig((s) => s.token);
  const signedIn = isSignedIn({ token });

  // Apply the light/dark preference; field mode is for daylight, so it wins.
  useEffect(() => {
    setColorScheme(fieldMode ? "light" : themePreference);
  }, [themePreference, fieldMode, setColorScheme]);

  // Hydrate the secure store once for the whole app — the sign-in gate here is
  // the only thing that decides what to mount. The ResMan device session
  // hydrates alongside it (and probes whether its cookies survived the
  // restart) so direct work-order writes know their standing immediately.
  useEffect(() => {
    if (!hydrated) {
      void hydrate();
      void useResManSession.getState().hydrate();
    }
  }, [hydrated, hydrate]);

  // Emergency push taps → the announced work order. Gated on the same
  // condition that mounts the protected stack: navigating any earlier (cold
  // start from a killed app) would push before the route exists.
  useEmergencyNotificationResponses(hydrated && signedIn);

  // A genuinely dead ResMan session sends the tech to sign-in to restore it —
  // their edits queue in the outbox until then, and the session only reads
  // "expired" on a real login bounce, never on a bad network (a no-signal
  // basement must never look like a sign-out).
  const resmanStatus = useResManSession((s) => s.status);
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (hydrated && signedIn && resmanStatus === "expired" && pathname !== "/sign-in") {
      router.push("/sign-in");
    }
  }, [hydrated, signedIn, resmanStatus, pathname, router]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AnalyticsProvider>
          {/* Runtime accent theme → CSS variables consumed by the Tailwind theme. */}
          <View style={[{ flex: 1 }, vars(accentVars(accentId))]}>
            <WorkspaceBackdrop />
            {/* Nothing mounts until the Keychain read settles, otherwise a signed-in
              device flashes the sign-in gate on every cold start. */}
            {hydrated ? (
              <ThemeProvider
                value={colorScheme === "dark" ? TRANSPARENT_NAV.dark : TRANSPARENT_NAV.light}
              >
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: "transparent" },
                  }}
                >
                  {/* Not signed in, no app: withholding these routes leaves `sign-in`
                    as the only place to land. */}
                  <Stack.Protected guard={signedIn}>
                    <Stack.Screen name="(tabs)" />
                    <Stack.Screen name="work-order/[id]" options={{ presentation: "modal" }} />
                    <Stack.Screen name="settings" options={{ presentation: "formSheet" }} />
                    <Stack.Screen name="outbox" options={{ presentation: "formSheet" }} />
                  </Stack.Protected>
                  <Stack.Screen name="sign-in" />
                </Stack>
              </ThemeProvider>
            ) : null}
            <StatusBar style="auto" />
          </View>
        </AnalyticsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// Sentry.wrap enables automatic performance/routing instrumentation and error
// boundary capture. Wrapping without an init'd client (no DSN configured)
// makes Sentry warn "`Sentry.wrap` was called before `Sentry.init`" on every
// launch — a blank native LogBox toast — so the wrap is gated with the init.
export default sentryEnabled ? Sentry.wrap(RootLayout) : RootLayout;
