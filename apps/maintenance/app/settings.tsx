import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";
import Constants from "expo-constants";
import { shouldCheckTranslation, translateNotice } from "@/lib/translation/availability-notice";
import {
  isTranslateModuleLinked,
  translateAvailability,
  translateBatchOrTimeout,
} from "@/lib/translation/native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import type { AppLanguage } from "@/lib/i18n";
import { registerForEmergencyPush, unregisterEmergencyPush } from "@/lib/push";
import { emergencyAlertNotice } from "@/lib/push/availability-notice";
import { useResManSession } from "@/lib/resman/session";
import { useConfig } from "@/lib/stores/config";
import { usePendingCloses } from "@/lib/stores/pending-closes";
import { usePendingEdits } from "@/lib/stores/pending-edits";
import { useWorkOrderPhotos } from "@/lib/stores/work-order-photos";
import { buildOutbox, pendingCount as outboxPendingCount } from "@/lib/derived/outbox";
import { useSettings } from "@/lib/stores/settings";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { HAIRLINE, type AccentThemeId } from "@/theme/tokens";
import { AccentPicker, Dropdown, ThemeCards } from "@/components/settings/AppearanceControls";
import { useAccentHex, useAccentPalette } from "@/lib/hooks/use-accent";

const NAVY = "#091B54";
const RED = "#D1382E";
const MUTED = "#70788F";

// Language names are shown in their own language on purpose — a Spanish
// speaker stuck in English must be able to find "Español".
const LANGUAGE_OPTIONS: { id: AppLanguage; label: string }[] = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      className="text-slate dark:text-white/60"
      style={{
        fontSize: 11,
        fontWeight: "700",
        letterSpacing: 1,
        marginTop: 18,
        marginBottom: 7,
        marginLeft: 4,
      }}
    >
      {children.toUpperCase()}
    </Text>
  );
}

function Row({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 12, gap: 12 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "600" }}>
          {label}
        </Text>
        {sub ? (
          <Text className="text-slate dark:text-white/60" style={{ fontSize: 11.5, marginTop: 1 }}>
            {sub}
          </Text>
        ) : null}
      </View>
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
  const palette = useAccentPalette();
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
          accessibilityRole="button"
          accessibilityState={value === o.id ? { selected: true } : {}}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 9,
            backgroundColor: value === o.id ? `${palette.fill}D9` : "transparent",
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
  const palette = useAccentPalette();
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
        backgroundColor: value ? `${palette.fill}D9` : "rgba(9,27,84,0.14)",
        alignItems: value ? "flex-end" : "flex-start",
        justifyContent: "center",
      }}
    >
      <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: "#FFFFFF" }} />
    </Pressable>
  );
}

/**
 * Settings, restructured to grow (approved mockup): profile card up top, then
 * Appearance / Map / Work / Data / Account sections. Surfaces settings that
 * already lived in the store without UI (accent theme, friendly dates,
 * occupancy tint) and makes sync state visible.
 */
export default function Settings() {
  const palette = useAccentPalette();
  const router = useRouter();
  const { t } = useTranslation();
  const settings = useSettings();

  // Switching to Spanish is the moment work-order prose is supposed to start
  // translating. When it can't, the sync path fails quietly by design and the
  // tech is left staring at English — so say why, here, once.

  const onPickLanguage = (language: AppLanguage) => {
    settings.setLanguage(language);
    if (!shouldCheckTranslation(language, Platform.OS)) return;
    void (async () => {
      const availability = await translateAvailability("en", language);
      const notice = translateNotice({
        availability,
        moduleLinked: isTranslateModuleLinked(),
        platform: Platform.OS,
      });
      if (notice) {
        Alert.alert(notice.title, notice.body);
        return;
      }
      // The OS says the pair is installed — so prove it end to end rather than
      // trusting the claim. `availability` reports what the system supports;
      // only a real batch exercises the session the work-order sync depends on,
      // and that is the part that has been failing without a word.
      try {
        await translateBatchOrTimeout(["Water heater leaking"], "en", language);
      } catch (err) {
        Alert.alert(
          "Translation isn't working",
          `The language pack is installed but a test translation failed:\n\n${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })();
  };
  const admin = useConfig((s) => s.admin);
  const token = useConfig((s) => s.token);
  const baseUrl = useConfig((s) => s.baseUrl);
  const signOut = useConfig((s) => s.signOut);
  const resmanStatus = useResManSession((s) => s.status);

  const workOrderCount = useWorkOrders((s) => s.workOrders.length);
  const refreshedAt = useWorkOrders((s) => s.refreshedAt);
  const refreshWorkOrders = useWorkOrders((s) => s.refresh);
  const unitCount = useUnits((s) => s.allUnits.length);
  const refreshUnits = useUnits((s) => s.refresh);
  const pending = usePendingCloses((s) => s.pending);
  const pendingEdits = usePendingEdits((s) => s.pending);
  const pendingPhotos = useWorkOrderPhotos((s) => s.pending);
  const photosSyncing = useWorkOrderPhotos((s) => s.syncing);
  const outboxCount = outboxPendingCount(
    buildOutbox({
      closes: Object.values(pending),
      edits: Object.values(pendingEdits),
      photos: pendingPhotos,
      photosSyncing,
    }),
  );
  const [syncBusy, setSyncBusy] = useState(false);

  const accent = useAccentHex();
  const themeOptions = [
    { id: "system" as const, label: t("settings.theme.system") },
    { id: "light" as const, label: t("settings.theme.light") },
    { id: "dark" as const, label: t("settings.theme.dark") },
  ];

  // Computed per render on purpose (Date.now in a memo trips the purity rule);
  // the screen re-renders on open/refresh, which is exactly when this matters.
  const syncedLine = (() => {
    if (refreshedAt === 0) return t("settings.neverSynced");
    const mins = Math.floor((Date.now() - refreshedAt) / 60_000);
    return mins < 1 ? t("settings.syncedJustNow") : t("settings.syncedMinutes", { count: mins });
  })();

  const onSyncNow = async () => {
    if (syncBusy) return;
    setSyncBusy(true);
    const config = { baseUrl, token };
    await Promise.allSettled([refreshWorkOrders(config), refreshUnits(config)]);
    setSyncBusy(false);
  };

  const onToggleEmergencyAlerts = (next: boolean) => {
    settings.setEmergencyAlerts(next);
    const config = { baseUrl, token };
    if (!next) {
      void unregisterEmergencyPush(config);
      return;
    }
    // Turning alerts ON is the one moment the tech is actually asking for this,
    // so it is the one moment worth telling them it didn't work. Registration
    // used to fail silently — the whole fleet had no push token for weeks
    // because the iOS build carried no entitlement, and nothing anywhere said
    // so. Never throws; the result is a reason code.
    void registerForEmergencyPush(config).then((result) => {
      if (result.ok) return;
      const notice = emergencyAlertNotice(result);
      if (notice) Alert.alert(notice.title, notice.body);
    });
  };

  const onSignOut = async () => {
    // Push cleanup, analytics reset and the cache purge all live inside
    // signOut() — this screen is one of two entry points and they must not
    // drift apart again.
    await signOut();
    // The root layout's guard drops the tabs; land on the sign-in gate.
    router.replace("/sign-in");
  };

  const displayName = admin?.displayName ?? "—";
  const version = Constants.expoConfig?.version ?? "";

  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 40 }}>
      <Text className="text-navy dark:text-white" style={{ fontSize: 24, fontWeight: "700" }}>
        {t("settings.title")}
      </Text>
      <Text
        className="text-slate dark:text-white/60"
        style={{ fontSize: 12.5, marginTop: 2, marginBottom: 16 }}
      >
        {t("settings.subtitle")}
      </Text>

      {/* Identity leads: who is signed in, with their role badge. */}
      <AppCardSurface kind="panel" style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View
            style={{
              width: 46,
              height: 46,
              borderRadius: 23,
              backgroundColor: NAVY,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: "#FFFFFF", fontSize: 16, fontWeight: "800" }}>
              {initialsOf(displayName)}
            </Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              className="text-navy dark:text-white"
              style={{ fontSize: 15, fontWeight: "800" }}
              numberOfLines={1}
            >
              {displayName}
            </Text>
            <Text
              className="text-slate dark:text-white/60"
              style={{ fontSize: 11.5, marginTop: 1 }}
            >
              {t("settings.signedInVia")}
            </Text>
          </View>
          {admin?.role ? (
            <View
              style={{
                borderRadius: 999,
                paddingHorizontal: 9,
                paddingVertical: 3,
                backgroundColor: `${palette.fill}1F`,
                borderWidth: 1,
                borderColor: `${palette.fill}66`,
              }}
            >
              {/* The scoped DEVICE role, mapped to what it means on this
                  surface: the maintenance app mints the units+work-orders
                  role, which happens to be NAMED security_manager server-side
                  (see app-token/route.ts) — showing that name here reads as a
                  permissions bug. */}
              <Text style={{ fontSize: 9, fontWeight: "800", color: "#767B24" }}>
                {(admin.role === "security_manager" ? "maintenance" : admin.role)
                  .replace(/_/g, " ")
                  .toUpperCase()}
              </Text>
            </View>
          ) : null}
        </View>
      </AppCardSurface>

      <SectionLabel>{t("settings.appearance")}</SectionLabel>
      <AppCardSurface kind="panel" style={{ paddingHorizontal: 18, paddingVertical: 4 }}>
        <View style={{ paddingVertical: 11 }}>
          <Text
            className="text-navy dark:text-white"
            style={{ fontSize: 13.5, fontWeight: "600", marginBottom: 8 }}
          >
            {t("settings.themeLabel")}
          </Text>
          <ThemeCards
            value={settings.themePreference}
            options={themeOptions}
            accent={accent}
            onChange={settings.setThemePreference}
          />
        </View>
        <Row label={t("settings.fieldMode")} sub={t("settings.fieldModeSub")}>
          <Toggle value={settings.fieldMode} onChange={settings.setFieldMode} />
        </Row>
        <View style={{ paddingVertical: 11, borderTopWidth: 1, borderTopColor: HAIRLINE }}>
          <Text className="text-navy dark:text-white" style={{ fontSize: 13.5, fontWeight: "600" }}>
            {t("settings.accent")}
          </Text>
          <AccentPicker value={settings.accentId} onChange={settings.setAccent} />
        </View>
        <Row label={t("settings.language")}>
          <Dropdown
            value={settings.language}
            options={LANGUAGE_OPTIONS}
            accent={accent}
            onChange={onPickLanguage}
          />
        </Row>
      </AppCardSurface>

      <SectionLabel>{t("settings.map")}</SectionLabel>
      <AppCardSurface kind="panel" style={{ paddingHorizontal: 18, paddingVertical: 4 }}>
        <Row label={t("settings.utilityLayer")} sub={t("settings.utilityLayerSub")}>
          <Toggle value={settings.utilityLayerVisible} onChange={settings.setUtilityLayerVisible} />
        </Row>
      </AppCardSurface>

      <SectionLabel>{t("settings.work")}</SectionLabel>
      <AppCardSurface kind="panel" style={{ paddingHorizontal: 18, paddingVertical: 4 }}>
        <Row label={t("settings.friendlyDates")} sub={t("settings.friendlyDatesSub")}>
          <Toggle value={settings.humanReadableDates} onChange={settings.setHumanReadableDates} />
        </Row>
        <Row label={t("settings.emergencyAlerts")} sub={t("settings.emergencyAlertsSub")}>
          <Toggle value={settings.emergencyAlerts} onChange={onToggleEmergencyAlerts} />
        </Row>
      </AppCardSurface>

      <SectionLabel>{t("settings.data")}</SectionLabel>
      <AppCardSurface kind="panel" style={{ paddingHorizontal: 18, paddingVertical: 4 }}>
        <Row
          label={syncedLine}
          sub={t("settings.dataCounts", { workOrders: workOrderCount, units: unitCount })}
        >
          <Pressable
            onPress={onSyncNow}
            accessibilityRole="button"
            disabled={syncBusy}
            style={{ opacity: syncBusy ? 0.5 : 1 }}
          >
            <Text style={{ fontSize: 13, fontWeight: "700", color: "#767B24" }}>
              {t("settings.syncNow")}
            </Text>
          </Pressable>
        </Row>
        <Pressable
          onPress={() => router.push("/outbox")}
          accessibilityRole="button"
          accessibilityLabel="Open outbox"
        >
          <Row
            label={t("settings.outbox")}
            sub={
              outboxCount > 0
                ? t("outbox.waiting", { count: outboxCount })
                : t("outbox.allDelivered")
            }
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {outboxCount > 0 ? (
                <View
                  style={{
                    minWidth: 22,
                    height: 22,
                    paddingHorizontal: 6,
                    borderRadius: 11,
                    backgroundColor: "#E38736",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: "#FFFFFF", fontSize: 12, fontWeight: "800" }}>
                    {outboxCount}
                  </Text>
                </View>
              ) : null}
              <Ionicons name="chevron-forward" size={16} color={MUTED} />
            </View>
          </Row>
        </Pressable>
      </AppCardSurface>

      <SectionLabel>{t("settings.account")}</SectionLabel>
      <AppCardSurface kind="panel" style={{ paddingHorizontal: 18, paddingVertical: 4 }}>
        {/* The device-held ResMan session that direct work-order writes ride
            on. Expired/absent means edits and closes wait in the outbox until
            the tech signs in again — say so where they will look. */}
        <View style={{ paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: resmanStatus === "active" ? "#33A666" : "#B05E14",
            }}
          />
          <Text
            className="text-navy dark:text-white"
            style={{ fontSize: 15, fontWeight: "600", flex: 1 }}
          >
            {t("settings.resmanSession")}
          </Text>
          <Text className="text-slate dark:text-white/60" style={{ fontSize: 12.5 }}>
            {resmanStatus === "active"
              ? t("settings.resmanSessionActive")
              : resmanStatus === "unverified"
                ? t("settings.resmanSessionChecking")
                : t("settings.resmanSessionExpired")}
          </Text>
        </View>
        <Pressable
          onPress={() => router.push("/sign-in")}
          accessibilityRole="button"
          style={{ paddingVertical: 12 }}
        >
          <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "600" }}>
            {t("settings.switchUser")}
          </Text>
        </Pressable>
        <Pressable onPress={onSignOut} accessibilityRole="button" style={{ paddingVertical: 12 }}>
          <Text style={{ color: RED, fontSize: 15, fontWeight: "700" }}>
            {t("settings.signOut")}
          </Text>
        </Pressable>
      </AppCardSurface>

      {version ? (
        <Text
          className="text-muted dark:text-white/40"
          style={{ fontSize: 10.5, textAlign: "center", marginTop: 18 }}
        >
          Emberly Maintenance {version}
        </Text>
      ) : null}
    </ScrollView>
  );
}
