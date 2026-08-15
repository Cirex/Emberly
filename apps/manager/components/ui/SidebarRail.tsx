import { EmberlyBrandLogo } from "@emberly/ui";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InitialsBadge } from "@/components/ui/InitialsBadge";
import { buildOpenBoard, buildWorkData } from "@/lib/derived/work-boards";
import { buildPipelineRows, unitFactsIndex } from "@/lib/derived/leasing";
import { useConfig } from "@/lib/stores/config";
import { useLeases } from "@/lib/stores/leases";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { OLIVE } from "@/theme/tokens";

/** Fixed rail width — the mockup's 216px column. Screens pad left by this on wide. */
export const RAIL_WIDTH = 216;

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

/**
 * Structural slice of what expo-router's Tabs passes to a custom `tabBar`. We
 * type only what the rail reads (see FloatingTabBar for the same pattern).
 */
type TabNav = {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    emit(event: { type: "tabPress"; target: string; canPreventDefault: true }): {
      defaultPrevented: boolean;
    };
    navigate(name: string): void;
  };
};

const RED = "#E0584D";
const IDLE = "rgba(255,255,255,0.66)";

/** The six primary destinations are tab routes; their icons match the mockup rail. */
const TAB_ICONS: Record<string, IoniconName> = {
  index: "grid-outline",
  leasing: "person-add-outline",
  delinquency: "cash-outline",
  work: "construct-outline",
  utilities: "flash-outline",
  "property-map": "map-outline",
};
/** Rail order — same as the tab navigator, so `state.index` maps 1:1. */
const TAB_ORDER = ["index", "leasing", "delinquency", "work", "utilities", "property-map"];

function NavItem({
  icon,
  label,
  active,
  onPress,
  badge,
  badgeTone,
}: {
  icon: IoniconName;
  label: string;
  active?: boolean;
  onPress: () => void;
  badge?: number;
  badgeTone?: "olive" | "red";
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={active ? { selected: true } : {}}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 11,
        borderRadius: 11,
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginBottom: 2,
        backgroundColor: active ? "rgba(255,255,255,0.12)" : "transparent",
        borderWidth: 1,
        borderColor: active ? "rgba(255,255,255,0.10)" : "transparent",
      }}
    >
      <Ionicons name={icon} size={17} color={active ? "#fff" : IDLE} style={{ opacity: active ? 1 : 0.85 }} />
      <Text
        numberOfLines={1}
        style={{ flex: 1, fontSize: 12.5, fontWeight: "700", color: active ? "#fff" : IDLE }}
      >
        {label}
      </Text>
      {badge !== undefined && badge > 0 ? (
        <View
          style={{
            borderRadius: 999,
            paddingHorizontal: 7,
            paddingVertical: 2,
            backgroundColor: badgeTone === "red" ? RED : OLIVE,
          }}
        >
          <Text
            style={{
              fontSize: 9.5,
              fontWeight: "800",
              color: badgeTone === "red" ? "#fff" : "#1E2500",
              fontVariant: ["tabular-nums"],
            }}
          >
            {badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * The tablet navigation rail (mockup frame 02): a deep-navy gradient column
 * that replaces the bottom tab bar on wide screens. The six primary
 * destinations are the tab routes (active state + switching come from the tab
 * navigator); People / Trends / Settings push their existing sheet routes. The
 * account lives at the foot — identity display that opens Settings / Sign Out.
 *
 * Rendered by `(tabs)/_layout.tsx`'s custom tabBar only when wide; the phone
 * keeps the FloatingTabBar. Screen content is cleared of the rail via the tab
 * navigator's `sceneStyle` left padding, so the rail overlays nothing.
 */
export function SidebarRail({ state, navigation }: TabNav) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const router = useRouter();
  const admin = useConfig((s) => s.admin);
  const signOut = useConfig((s) => s.signOut);

  const workOrders = useWorkOrders((s) => s.workOrders);
  const allUnits = useUnits((s) => s.allUnits);
  const leases = useLeases((s) => s.leases);

  // Badge counts, derived with the same engines the boards use. `nowMs` lives in
  // state (refreshed on a coarse interval) so the day-banding stays live without
  // an impure Date.now() in the render path.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const openWork = useMemo(
    () => buildOpenBoard(buildWorkData(workOrders, allUnits), nowMs).openCount,
    [workOrders, allUnits, nowMs],
  );
  const pipelineCount = useMemo(
    () => buildPipelineRows(leases, unitFactsIndex(allUnits), nowMs).length,
    [leases, allUnits, nowMs],
  );

  const activeName = state.routes[state.index]?.name;

  const goTab = (name: string) => {
    const route = state.routes.find((r) => r.name === name);
    if (!route) return;
    const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
    if (activeName !== name && !event.defaultPrevented) navigation.navigate(name);
  };

  const name = admin?.displayName?.trim() || "Signed In";
  const role = admin?.role ? admin.role.replace(/_/g, " ") : "";

  const onAccount = () => {
    Alert.alert(name, role ? role.toUpperCase() : undefined, [
      { text: "Settings", onPress: () => router.push("/settings") },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: () =>
          Alert.alert("Sign out?", `${name} will need to sign back in with ResMan credentials.`, [
            { text: "Cancel", style: "cancel" },
            { text: "Sign Out", style: "destructive", onPress: () => void signOut() },
          ]),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const labelFor: Record<string, string> = {
    index: t("tabs.today"),
    leasing: t("tabs.leasing"),
    delinquency: t("tabs.money"),
    work: t("work.title"),
    utilities: t("tabs.utilities"),
    "property-map": t("tabs.map"),
  };

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: RAIL_WIDTH,
        paddingTop: insets.top + 14,
        paddingBottom: insets.bottom + 14,
        paddingHorizontal: 12,
        flexDirection: "column",
      }}
    >
      {/* The mockup's 180deg #0D2166 → #091B54 rail gradient. */}
      <LinearGradient
        colors={["#0D2166", "#091B54"]}
        locations={[0, 0.7]}
        style={StyleSheet.absoluteFill}
      />

      {/* Brand lockup — the real reversed artwork (mockup: the rail wears the
          same asset the admin portal sidebar uses), not a recomposed
          icon-plus-tracked-text stand-in. */}
      <View style={{ paddingHorizontal: 10, paddingBottom: 18, paddingTop: 6, alignItems: "center" }}>
        <EmberlyBrandLogo variant="reversed" size={92} />
      </View>

      {/* Primary destinations (tab routes) */}
      {TAB_ORDER.map((routeName) => (
        <NavItem
          key={routeName}
          icon={TAB_ICONS[routeName] ?? "ellipse-outline"}
          label={labelFor[routeName] ?? routeName}
          active={activeName === routeName}
          onPress={() => goTab(routeName)}
          badge={routeName === "work" ? openWork : routeName === "leasing" ? pipelineCount : undefined}
          badgeTone={routeName === "work" ? "red" : "olive"}
        />
      ))}

      <View style={{ height: 1, backgroundColor: "rgba(255,255,255,0.10)", marginVertical: 10, marginHorizontal: 10 }} />

      {/* Secondary destinations (sheet routes) */}
      <NavItem icon="people-outline" label={t("people.title")} onPress={() => router.push("/people")} />
      <NavItem icon="trending-up-outline" label={t("trends.title")} onPress={() => router.push("/trends")} />

      {/* Foot: Settings + the account identity pill */}
      <View style={{ marginTop: "auto" }}>
        <NavItem icon="settings-outline" label="Settings" onPress={() => router.push("/settings")} />
        <Pressable
          onPress={onAccount}
          accessibilityRole="button"
          accessibilityLabel={`Account menu for ${name}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            marginTop: 8,
            paddingVertical: 9,
            paddingHorizontal: 11,
            borderRadius: 12,
            backgroundColor: "rgba(255,255,255,0.07)",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.12)",
          }}
        >
          <InitialsBadge name={name} size={28} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: "800", color: "#fff" }}>
              {name}
            </Text>
            {role ? (
              <Text numberOfLines={1} style={{ fontSize: 9, color: "rgba(255,255,255,0.55)" }}>
                {role.replace(/\b\w/g, (c) => c.toUpperCase())}
              </Text>
            ) : null}
          </View>
        </Pressable>
      </View>
    </View>
  );
}
