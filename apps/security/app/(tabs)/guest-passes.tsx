import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { AppFilterChip } from "@/components/ui/AppFilterChip";
import { AppScreenHeader } from "@/components/ui/AppScreenHeader";
import { AppSearchField } from "@/components/ui/AppSearchField";
import { AppStatusBadge } from "@emberly/ui";
import { residentList } from "@/lib/api/guest-passes";
import { PASS_FILTERS, PASS_STATUS_META } from "@/lib/guest-pass-display";
import { useConfig } from "@/lib/stores/config";
import { useGuestPasses } from "@/lib/stores/guest-passes";

export default function GuestPassesScreen() {
  const router = useRouter();
  const config = useConfig();
  const gp = useGuestPasses();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const hPad = width >= 1040 ? 34 : 24;

  // (Re)load on mount and whenever the status filter changes.
  useEffect(() => {
    if (config.hydrated) void gp.load(config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.hydrated, gp.status]);

  // Debounced search.
  useEffect(() => {
    if (!config.hydrated) return;
    const t = setTimeout(() => void gp.load(config), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gp.search]);

  const openSettings = () => router.push("/settings");

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingTop: insets.top + 26, paddingHorizontal: hPad, paddingBottom: insets.bottom + 96, gap: 18 }}
      refreshControl={
        <RefreshControl refreshing={gp.loading} onRefresh={() => gp.load(config)} tintColor="#70788F" />
      }
    >
      <AppScreenHeader
        title="Guest Passes"
        subtitle="Review, verify, and revoke resident-issued guest passes."
        trailing={
          <>
            <AppSearchField value={gp.search} onChangeText={gp.setSearch} placeholder="Search passes" width={240} />
            <Pressable
              onPress={openSettings}
              accessibilityLabel="Device setup"
              className="bg-white dark:bg-white/10"
              style={{ width: 44, height: 44, borderRadius: 999, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(9,27,84,0.12)" }}
            >
              <Ionicons name="settings-outline" size={20} color="#4C556F" />
            </Pressable>
          </>
        }
      />

      <View className="flex-row flex-wrap" style={{ gap: 8 }}>
        {PASS_FILTERS.map((s) => (
          <AppFilterChip
            key={s}
            label={PASS_STATUS_META[s].label}
            selected={gp.status === s}
            onPress={() => gp.setStatus(s)}
          />
        ))}
      </View>

      {gp.error ? (
        <AppCardSurface kind="row">
          <View style={{ padding: 16, gap: 6 }}>
            <Text className="text-status-blocked" style={{ fontSize: 15, fontWeight: "700" }}>
              Couldn&apos;t load passes
            </Text>
            <Text className="text-muted" style={{ fontSize: 14 }}>{gp.error}</Text>
          </View>
        </AppCardSurface>
      ) : gp.passes.length === 0 && !gp.loading ? (
        <Text className="text-muted" style={{ fontSize: 14, paddingHorizontal: 4, paddingTop: 8 }}>
          No {PASS_STATUS_META[gp.status].label.toLowerCase()} passes.
        </Text>
      ) : (
        <View style={{ gap: 9 }}>
          {gp.passes.map((p) => {
            const host = residentList(p)[0];
            const meta = PASS_STATUS_META[p.status];
            return (
              <Pressable key={p.id} onPress={() => router.push(`/guest-pass/${p.id}`)}>
                <AppCardSurface kind="row">
                  <View className="flex-row items-center justify-between" style={{ padding: 16, gap: 12 }}>
                    <View style={{ flex: 1 }}>
                      <Text className="text-navy dark:text-white" style={{ fontSize: 17, fontWeight: "700" }}>
                        {p.guest_name}
                      </Text>
                      <Text className="text-slate dark:text-white/70" style={{ fontSize: 14 }}>
                        {host ? `Host: ${host.name}` : "Host unknown"}
                        {host?.unit_id ? ` · ${host.unit_id}` : ""}
                      </Text>
                    </View>
                    <AppStatusBadge label={meta.label} tint={meta.tint} />
                    <Ionicons name="chevron-forward" size={16} color="rgba(9,27,84,0.4)" />
                  </View>
                </AppCardSurface>
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}
