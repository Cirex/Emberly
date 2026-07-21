import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { capture } from "@/lib/analytics";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { getScannerProfile, type ScannerProfile } from "@/lib/api/scanner";
import { useConfig } from "@/lib/stores/config";
import { useSettings } from "@/lib/stores/settings";
import type { AppThemePreference } from "@/theme/tokens";

type ThemeIcon = React.ComponentProps<typeof Ionicons>["name"];

const THEMES: { key: AppThemePreference; label: string; icon: ThemeIcon }[] = [
  { key: "system", label: "System", icon: "contrast" },
  { key: "light", label: "Light", icon: "sunny" },
  { key: "dark", label: "Dark", icon: "moon" },
];

const OLIVE = "#A2A921";
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/** "Jul 8" — enough for "how long has this device been at it". */
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      className="text-slate dark:text-white/60"
      style={{ fontSize: 12, fontWeight: "600", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 8 }}
    >
      {children}
    </Text>
  );
}

function Hairline() {
  return <View style={{ height: 1, backgroundColor: "rgba(9,27,84,0.08)" }} />;
}

export default function SettingsScreen() {
  const config = useConfig();
  const themePreference = useSettings((s) => s.themePreference);
  const setThemePreference = useSettings((s) => s.setThemePreference);
  const fieldMode = useSettings((s) => s.fieldMode);
  const setFieldMode = useSettings((s) => s.setFieldMode);

  const [profile, setProfile] = useState<ScannerProfile | null>(null);
  const [profileError, setProfileError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getScannerProfile(config)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch(() => {
        if (!cancelled) setProfileError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stat = (n: number | undefined): string =>
    profile ? String(n ?? 0) : profileError ? "—" : "…";

  // Clearing the key flips the root gate (isScannerConfigured) to false, which
  // withholds every screen in the protected stack and lands on `setup` — the
  // way out of a device holding a key the server no longer accepts.
  const deactivate = () => {
    Alert.alert(
      "Deactivate this device?",
      "This removes the scanner key from this device. To use it again you'll enter a new key from the admin portal.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Deactivate",
          style: "destructive",
          onPress: () => {
            capture("scanner_deactivated", { source: "manual" });
            void config.deactivate();
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      className="bg-paper-mid dark:bg-night-surface"
      contentContainerStyle={{ padding: 26, paddingBottom: 44 }}
    >
      <View className="flex-row items-center justify-between" style={{ marginBottom: 18 }}>
        <View>
          <Text className="text-navy dark:text-white" style={{ fontSize: 26, fontWeight: "700" }}>
            Settings
          </Text>
          <Text className="text-slate dark:text-white/70" style={{ fontSize: 13, fontWeight: "500" }}>
            Device preferences and activity
          </Text>
        </View>
        <Pressable
          onPress={() => router.back()}
          accessibilityLabel="Close settings"
          hitSlop={8}
          className="items-center justify-center rounded-full bg-white dark:bg-white/10"
          style={{ width: 36, height: 36, borderWidth: 1, borderColor: "rgba(9,27,84,0.12)" }}
        >
          <Ionicons name="close" size={18} color="#4C556F" />
        </Pressable>
      </View>

      <SectionLabel>Appearance</SectionLabel>
      <AppCardSurface kind="row" style={{ marginBottom: 20 }}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 12 }}>
          <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "500" }}>
            Theme
          </Text>
          {/* Three swatch tiles rather than a text segment — each previews the
              scheme it selects (paper, daylight white, night surface). */}
          <View className="flex-row" style={{ gap: 10 }}>
            {THEMES.map((t) => {
              const selected = themePreference === t.key;
              const dark = t.key === "dark";
              return (
                <Pressable
                  key={t.key}
                  onPress={() => setThemePreference(t.key)}
                  accessibilityRole="button"
                  accessibilityState={selected ? { selected: true } : {}}
                  style={{
                    flex: 1,
                    borderRadius: 13,
                    borderWidth: selected ? 1.6 : 1,
                    borderColor: selected ? OLIVE : "rgba(9,27,84,0.12)",
                    backgroundColor: dark ? "#1B1D20" : t.key === "light" ? "#FFFFFF" : "#F4F1E6",
                    paddingVertical: 13,
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Ionicons
                    name={t.icon}
                    size={19}
                    color={selected ? (dark ? "#C6CC4B" : "#767B24") : dark ? "rgba(255,255,255,0.55)" : "#70788F"}
                  />
                  <Text
                    style={{
                      fontSize: 12.5,
                      fontWeight: selected ? "700" : "500",
                      color: dark ? "#FFFFFF" : "#091B54",
                    }}
                  >
                    {t.label}
                  </Text>
                  {selected ? (
                    <View
                      style={{
                        position: "absolute",
                        top: 7,
                        right: 7,
                        width: 16,
                        height: 16,
                        borderRadius: 8,
                        backgroundColor: OLIVE,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Ionicons name="checkmark" size={11} color="#FFFFFF" />
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>
        <Hairline />
        <View
          className="flex-row items-center justify-between"
          style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 14 }}
        >
          <View style={{ flexShrink: 1 }}>
            <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "500" }}>
              Field mode
            </Text>
            <Text className="text-slate dark:text-white/60" style={{ fontSize: 12.5, marginTop: 2 }}>
              Brighter surfaces and stronger borders for daylight use
            </Text>
          </View>
          <Switch
            value={fieldMode}
            onValueChange={setFieldMode}
            trackColor={{ true: OLIVE, false: undefined }}
            accessibilityLabel="Field mode"
          />
        </View>
      </AppCardSurface>

      <SectionLabel>This device</SectionLabel>
      <AppCardSurface kind="row" style={{ marginBottom: 20 }}>
        <View className="flex-row items-center justify-between" style={{ paddingHorizontal: 16, minHeight: 50 }}>
          <Text className="text-slate dark:text-white/60" style={{ fontSize: 14 }}>
            Scanner name
          </Text>
          <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "600" }}>
            {profile ? profile.scanner.name : profileError ? "Unavailable" : "…"}
          </Text>
        </View>
        <Hairline />
        <View className="flex-row items-center justify-between" style={{ paddingHorizontal: 16, minHeight: 50 }}>
          <Text className="text-slate dark:text-white/60" style={{ fontSize: 14 }}>
            Scanner ID
          </Text>
          <View
            style={{ backgroundColor: "rgba(9,27,84,0.05)", borderRadius: 7, paddingHorizontal: 9, paddingVertical: 3 }}
          >
            <Text style={{ fontSize: 13, color: "#4C556F", fontFamily: MONO }}>
              {profile ? profile.scanner.id : profileError ? "—" : "…"}
            </Text>
          </View>
        </View>
        <Hairline />
        <Text className="text-muted" style={{ fontSize: 11.5, paddingHorizontal: 16, paddingVertical: 9 }}>
          Assigned by the office — managed in the admin portal.
        </Text>
      </AppCardSurface>

      <SectionLabel>Activity</SectionLabel>
      <View className="flex-row" style={{ gap: 10, marginBottom: 10 }}>
        <StatTile label="Scans today" value={stat(profile?.today.scans)} tone="olive" />
        <StatTile label="Approved" value={stat(profile?.today.entries)} tone="olive" />
        <StatTile label="Refused" value={stat(profile?.today.refused)} tone="clay" />
      </View>
      <View className="flex-row" style={{ gap: 10 }}>
        <StatTile label="All-time scans" value={stat(profile?.total.scans)} tone="navy" />
        <StatTile label="Guests admitted" value={stat(profile?.total.guest)} tone="navy" />
        <StatTile
          label="Active since"
          value={profile ? shortDate(profile.scanner.activeSince) : profileError ? "—" : "…"}
          tone="navy"
        />
      </View>
      {profileError ? (
        <Text className="text-muted" style={{ fontSize: 12, marginTop: 12 }}>
          Activity is unavailable right now — check the connection and reopen Settings.
        </Text>
      ) : null}

      <View style={{ marginTop: 26 }}>
        <SectionLabel>Device access</SectionLabel>
        <AppCardSurface kind="row">
          <Pressable
            onPress={deactivate}
            accessibilityRole="button"
            accessibilityLabel="Deactivate this device"
            className="flex-row items-center justify-between"
            style={{ paddingHorizontal: 16, minHeight: 52 }}
          >
            <Text style={{ fontSize: 15, fontWeight: "600", color: TILE_TONES.clay.value }}>
              Deactivate this device
            </Text>
            <Ionicons name="log-out-outline" size={19} color={TILE_TONES.clay.label} />
          </Pressable>
          <Hairline />
          <Text className="text-muted" style={{ fontSize: 11.5, paddingHorizontal: 16, paddingVertical: 9 }}>
            Removes the stored scanner key and returns to setup. Use this if the device shows “not authorized”, then
            enter a fresh key from the admin portal.
          </Text>
        </AppCardSurface>
      </View>
    </ScrollView>
  );
}

const TILE_TONES = {
  olive: { bg: "#F4F3E7", label: "#767B24", value: "#4C5410" },
  clay: { bg: "#FAF0EC", label: "#A34A32", value: "#7C3220" },
  navy: { bg: "rgba(9,27,84,0.045)", label: "#70788F", value: "#091B54" },
} as const;

function StatTile({ label, value, tone }: { label: string; value: string; tone: keyof typeof TILE_TONES }) {
  const t = TILE_TONES[tone];
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 }}>
      <Text style={{ fontSize: 12, fontWeight: "500", color: t.label }}>{label}</Text>
      <Text style={{ fontSize: 23, fontWeight: "600", color: t.value, marginTop: 2 }}>{value}</Text>
    </View>
  );
}
