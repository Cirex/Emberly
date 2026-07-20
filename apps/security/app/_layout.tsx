import "../global.css";

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme, vars } from "nativewind";
import { PropsWithChildren, useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PostHogProvider } from "posthog-react-native";
import { WorkspaceBackdrop } from "@/components/ui/WorkspaceBackdrop";
import { posthog } from "@/lib/analytics";
import { initSentry, Sentry, sentryEnabled } from "@/lib/sentry";
import { isScannerConfigured, useConfig } from "@/lib/stores/config";
import { useSettings } from "@/lib/stores/settings";
import { accentVars } from "@/theme/tokens";

// Initialize crash/error reporting as early as possible. No-op without a DSN.
initSentry();

// Wrap the app in PostHogProvider only when a client exists (key configured);
// otherwise render children untouched so analytics stays fully inert.
function AnalyticsProvider({ children }: PropsWithChildren) {
  if (!posthog) return <>{children}</>;
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}

/**
 * The navigator paints its theme's `colors.background` across the whole
 * navigation container — an opaque rgb(242,242,242) by default — which sits
 * between the backdrop and the screens and hides it completely. `contentStyle` /
 * `sceneStyle` don't help: they style the screen, not the container behind it.
 * Making it transparent is what lets WorkspaceBackdrop show at all.
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
  const scannerKey = useConfig((s) => s.scannerKey);
  const configured = isScannerConfigured({ scannerKey });

  // Apply the light/dark preference (System/Light/Dark → NativeWind).
  // Field mode is for daylight, so it always wins with light.
  useEffect(() => {
    setColorScheme(fieldMode ? "light" : themePreference);
  }, [themePreference, fieldMode, setColorScheme]);

  // Hydrate the secure store once for the whole app — the screens below read
  // config but never load it, so the key gate here is the only thing that can
  // decide what to mount.
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AnalyticsProvider>
          {/* Runtime accent theme → CSS variables consumed by the Tailwind theme. */}
          <View style={[{ flex: 1 }, vars(accentVars(accentId))]}>
            <WorkspaceBackdrop />
            {/* Nothing mounts until the Keychain read settles, otherwise a configured
              device flashes the setup gate on every cold start. */}
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
                  {/* No key, no app: withholding these routes leaves `setup` as the only
                    place to land, so each view no longer needs its own key prompt. */}
                  <Stack.Protected guard={configured}>
                    <Stack.Screen name="(tabs)" />
                    <Stack.Screen
                      name="photo-capture"
                      options={{ presentation: "fullScreenModal" }}
                    />
                    <Stack.Screen name="guest-pass/[id]" options={{ presentation: "modal" }} />
                    <Stack.Screen name="settings" options={{ presentation: "formSheet" }} />
                  </Stack.Protected>
                  <Stack.Screen name="setup" />
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
// boundary capture. Wrapping without an init'd client (no DSN configured) makes
// Sentry warn "`Sentry.wrap` was called before `Sentry.init`" on every launch —
// a blank native LogBox toast — so the wrap is gated with the init.
export default sentryEnabled ? Sentry.wrap(RootLayout) : RootLayout;
