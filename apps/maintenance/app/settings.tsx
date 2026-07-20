import { useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { capture, resetAnalytics } from "@/lib/analytics";
import { useConfig } from "@/lib/stores/config";
import { useSettings } from "@/lib/stores/settings";
import type { AppThemePreference } from "@/theme/tokens";

const THEME_OPTIONS: { id: AppThemePreference; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 12 }}>
      <Text className="text-navy" style={{ fontSize: 16, fontWeight: "600", flex: 1 }}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function Segments<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        borderRadius: 12,
        backgroundColor: "rgba(9,27,84,0.06)",
        padding: 3,
        gap: 2,
      }}
    >
      {options.map((o) => (
        <Pressable
          key={o.id}
          onPress={() => onChange(o.id)}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 9,
            backgroundColor: value === o.id ? "rgba(162,169,33,0.85)" : "transparent",
          }}
        >
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: value === o.id ? "#FFFFFF" : "#4C556F",
            }}
          >
            {o.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      style={{
        width: 52,
        height: 30,
        borderRadius: 16,
        padding: 3,
        backgroundColor: value ? "rgba(162,169,33,0.85)" : "rgba(9,27,84,0.14)",
        alignItems: value ? "flex-end" : "flex-start",
        justifyContent: "center",
      }}
    >
      <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: "#FFFFFF" }} />
    </Pressable>
  );
}

/** Lean settings: appearance + account. Grows alongside the feature set. */
export default function Settings() {
  const router = useRouter();
  const settings = useSettings();
  const admin = useConfig((s) => s.admin);
  const signOut = useConfig((s) => s.signOut);

  const onSignOut = async () => {
    // Record the sign-out while still identified, then clear the identity so
    // later events aren't attributed to this staff member.
    capture("signed_out");
    resetAnalytics();
    await signOut();
    // The root layout's guard drops the tabs; land on the sign-in gate.
    router.replace("/sign-in");
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
      <Text className="text-navy" style={{ fontSize: 24, fontWeight: "700" }}>
        Settings
      </Text>

      <AppCardSurface kind="panel" style={{ paddingHorizontal: 18, paddingVertical: 6 }}>
        <Row label="Appearance">
          <Segments
            value={settings.themePreference}
            options={THEME_OPTIONS}
            onChange={settings.setThemePreference}
          />
        </Row>
        <Row label="Field Mode">
          <Toggle value={settings.fieldMode} onChange={settings.setFieldMode} />
        </Row>
      </AppCardSurface>

      <AppCardSurface kind="panel" style={{ paddingHorizontal: 18, paddingVertical: 6 }}>
        <Row label="Signed in as">
          <Text className="text-slate" style={{ fontSize: 15, fontWeight: "600" }}>
            {admin?.displayName ?? "—"}
          </Text>
        </Row>
        <Pressable onPress={onSignOut} style={{ paddingVertical: 12 }}>
          <Text style={{ color: "#D1382E", fontSize: 16, fontWeight: "700" }}>Sign Out</Text>
        </Pressable>
      </AppCardSurface>
    </ScrollView>
  );
}
