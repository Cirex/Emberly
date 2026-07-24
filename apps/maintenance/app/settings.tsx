import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";
import Constants from "expo-constants";
import {
  shouldCheckTranslation,
  translateNotice,
} from "@/lib/translation/availability-notice";
import { lookupTranslation, pendingSources } from "@/lib/translation/cache";
import { orderedTranslationSources } from "@/lib/translation/sources";
import { useMyDay } from "@/lib/stores/my-day";
import { useTranslations } from "@/lib/stores/translations";
import {
  isTranslateModuleLinked,
  translateAvailability,
  translateBatchOrTimeout,
} from "@/lib/translation/native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { capture, resetAnalytics } from "@/lib/analytics";
import type { AppLanguage } from "@/lib/i18n";
import { registerForEmergencyPush, unregisterEmergencyPush } from "@/lib/push";
import { useConfig } from "@/lib/stores/config";
import { usePendingCloses } from "@/lib/stores/pending-closes";
import { useSettings } from "@/lib/stores/settings";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { ACCENT_THEMES, type AccentThemeId } from "@/theme/tokens";

const NAVY = "#091B54";
const RED = "#D1382E";

// Language names are shown in their own language on purpose — a Spanish
// speaker stuck in English must be able to find "Español".
const LANGUAGE_OPTIONS: { id: AppLanguage; label: string }[] = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
];

const ACCENT_IDS = Object.keys(ACCENT_THEMES) as AccentThemeId[];

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
      style={{ fontSize: 11, fontWeight: "700", letterSpacing: 1, marginTop: 18, marginBottom: 7, marginLeft: 4 }}
    >
      {children.toUpperCase()}
    </Text>
  );
}

function Row({ label, sub, children }: { label: string; sub?: string; children?: React.ReactNode }) {
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
  return (
    <View style={{ flexDirection: "row", borderRadius: 12, backgroundColor: "rgba(9,27,84,0.06)", padding: 3, gap: 2 }}>
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
            backgroundColor: value === o.id ? "rgba(162,169,33,0.85)" : "transparent",
          }}
        >
          <Text style={{ fontSize: 13, fontWeight: "600", color: value === o.id ? "#FFFFFF" : "#4C556F" }}>
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

/** One tappable accent swatch; selected gets the navy ring. */
function AccentSwatch({ id, selected, onPress }: { id: AccentThemeId; selected: boolean; onPress: () => void }) {
  const rgb = ACCENT_THEMES[id].header;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={ACCENT_THEMES[id].label}
      accessibilityState={selected ? { selected: true } : {}}
      style={{
        width: 26,
        height: 26,
        borderRadius: 13,
        backgroundColor: `rgb(${rgb})`,
        borderWidth: selected ? 2.5 : 0,
        borderColor: NAVY,
      }}
    />
  );
}

/**
 * Settings, restructured to grow (approved mockup): profile card up top, then
 * Appearance / Map / Work / Data / Account sections. Surfaces settings that
 * already lived in the store without UI (accent theme, friendly dates,
 * occupancy tint) and makes sync state visible.
 */
export default function Settings() {
  const router = useRouter();
  const { t } = useTranslation();
  const settings = useSettings();

  // Switching to Spanish is the moment work-order prose is supposed to start
  // translating. When it can't, the sync path fails quietly by design and the
  // tech is left staring at English — so say why, here, once.
  /**
   * Report every stage of the translation pipeline in one place.
   *
   * Each stage has failed independently at least once — the native session,
   * the cache, the sync pass, the render path — and each failure looked
   * identical from the outside: English prose. This says which link is broken
   * instead of leaving it to be guessed at one rebuild per hypothesis.
   */
  const onTranslationDiagnostics = async () => {
    const lang = useSettings.getState().language;
    // Probe Spanish even while the app is in English. The pipeline is a no-op
    // in English by design, so reporting "n/a" there would make the diagnostic
    // useless in exactly the mode someone is most likely to run it from.
    const probe: AppLanguage = lang === "en" ? "es" : lang;
    const orders = useWorkOrders.getState().workOrders;
    const entries = useTranslations.getState().entries;
    const priorityIds = useMyDay.getState().stops.flatMap((s) => s.workOrderIds);
    const sources = orderedTranslationSources(orders, priorityIds);
    const pending = pendingSources(probe, sources, entries);

    const sample = sources[0] ?? "";
    const cachedSample = sample ? lookupTranslation(entries, probe, sample) : null;

    const availability = await translateAvailability("en", probe);

    let live: string;
    try {
      const out = await translateBatchOrTimeout(["Water heater leaking"], "en", probe);
      live = out[0] ?? "(empty)";
    } catch (err) {
      live = `FAILED — ${err instanceof Error ? err.message : String(err)}`;
    }

    Alert.alert(
      "Translation diagnostics",
      [
        `language: ${lang}${lang === "en" ? ` (probing ${probe})` : ""}`,
        `moduleLinked: ${isTranslateModuleLinked()}`,
        `availability: ${availability}`,
        `workOrders: ${orders.length}`,
        `sources: ${sources.length}`,
        `cached entries: ${Object.keys(entries).length}`,
        `still pending: ${pending.length}`,
        `first source: ${sample.slice(0, 40) || "(none)"}`,
        `its cached value: ${cachedSample ?? "(none)"}`,
        `live test: ${live}`,
      ].join("\n"),
    );
  };

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

  const workOrderCount = useWorkOrders((s) => s.workOrders.length);
  const refreshedAt = useWorkOrders((s) => s.refreshedAt);
  const refreshWorkOrders = useWorkOrders((s) => s.refresh);
  const unitCount = useUnits((s) => s.allUnits.length);
  const refreshUnits = useUnits((s) => s.refresh);
  const pending = usePendingCloses((s) => s.pending);
  const pendingCount = Object.keys(pending).length;
  const [syncBusy, setSyncBusy] = useState(false);

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
    // Fire-and-forget: both calls warn internally and never throw.
    const config = { baseUrl, token };
    if (next) void registerForEmergencyPush(config);
    else void unregisterEmergencyPush(config);
  };

  const onSignOut = async () => {
    // Record the sign-out while still identified, then clear the identity so
    // later events aren't attributed to this staff member.
    capture("signed_out");
    resetAnalytics();
    // Stop emergency pushes for this device while the token still
    // authenticates the DELETE — after signOut it couldn't.
    await unregisterEmergencyPush({ baseUrl, token });
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
      <Text className="text-slate dark:text-white/60" style={{ fontSize: 12.5, marginTop: 2, marginBottom: 16 }}>
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
            <Text style={{ color: "#FFFFFF", fontSize: 16, fontWeight: "800" }}>{initialsOf(displayName)}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "800" }} numberOfLines={1}>
              {displayName}
            </Text>
            <Text className="text-slate dark:text-white/60" style={{ fontSize: 11.5, marginTop: 1 }}>
              {t("settings.signedInVia")}
            </Text>
          </View>
          {admin?.role ? (
            <View
              style={{
                borderRadius: 999,
                paddingHorizontal: 9,
                paddingVertical: 3,
                backgroundColor: "rgba(162,169,33,0.12)",
                borderWidth: 1,
                borderColor: "rgba(162,169,33,0.4)",
              }}
            >
              {/* Machine role value on purpose — roles are not translated. */}
              <Text style={{ fontSize: 9, fontWeight: "800", color: "#767B24" }}>
                {admin.role.replace(/_/g, " ").toUpperCase()}
              </Text>
            </View>
          ) : null}
        </View>
      </AppCardSurface>

      <SectionLabel>{t("settings.appearance")}</SectionLabel>
      <AppCardSurface kind="panel" style={{ paddingHorizontal: 18, paddingVertical: 4 }}>
        <Row label={t("settings.themeLabel")}>
          <Segments value={settings.themePreference} options={themeOptions} onChange={settings.setThemePreference} />
        </Row>
        <Row label={t("settings.fieldMode")} sub={t("settings.fieldModeSub")}>
          <Toggle value={settings.fieldMode} onChange={settings.setFieldMode} />
        </Row>
        <Row label={t("settings.accent")} sub={t("settings.accentSub")}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {ACCENT_IDS.map((id) => (
              <AccentSwatch key={id} id={id} selected={settings.accentId === id} onPress={() => settings.setAccent(id)} />
            ))}
          </View>
        </Row>
        <Row label={t("settings.language")}>
          <Segments value={settings.language} options={LANGUAGE_OPTIONS} onChange={onPickLanguage} />
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
          <Pressable onPress={onSyncNow} accessibilityRole="button" disabled={syncBusy} style={{ opacity: syncBusy ? 0.5 : 1 }}>
            <Text style={{ fontSize: 13, fontWeight: "700", color: "#767B24" }}>{t("settings.syncNow")}</Text>
          </Pressable>
        </Row>
        <Row
          label={t("settings.pendingChanges")}
          sub={pendingCount > 0 ? t("settings.pendingCloses", { count: pendingCount }) : t("settings.pendingNone")}
        />
        <Row label="Translation diagnostics" sub="Reports each stage of the pipeline">
          <Pressable onPress={onTranslationDiagnostics} accessibilityRole="button">
            <Text style={{ fontSize: 13, fontWeight: "700", color: "#767B24" }}>Run</Text>
          </Pressable>
        </Row>
      </AppCardSurface>

      <SectionLabel>{t("settings.account")}</SectionLabel>
      <AppCardSurface kind="panel" style={{ paddingHorizontal: 18, paddingVertical: 4 }}>
        <Pressable onPress={() => router.push("/sign-in")} accessibilityRole="button" style={{ paddingVertical: 12 }}>
          <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "600" }}>
            {t("settings.switchUser")}
          </Text>
        </Pressable>
        <Pressable onPress={onSignOut} accessibilityRole="button" style={{ paddingVertical: 12 }}>
          <Text style={{ color: RED, fontSize: 15, fontWeight: "700" }}>{t("settings.signOut")}</Text>
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
