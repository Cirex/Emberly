import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useColorScheme } from "nativewind";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import {
  buildOutbox,
  pendingCount as outboxPendingCount,
  type OutboxItem,
  type OutboxState,
} from "@/lib/derived/outbox";
import { useConfig } from "@/lib/stores/config";
import { usePendingCloses } from "@/lib/stores/pending-closes";
import { usePendingEdits } from "@/lib/stores/pending-edits";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { useWorkOrderPhotos } from "@/lib/stores/work-order-photos";

const NAVY = "#091B54";
const MUTED = "#70788F";
const SLATE = "#4C556F";
const GREEN = "#1F8A4C";
const INFO = "#2563B4";
const AMBER = "#E38736";
const RED = "#B3261E";

/**
 * The Outbox — a read-only view over the pending-close, pending-edit, and
 * work-order-photo stores, so a tech can see the work is captured and on its
 * way to ResMan. Reached from Settings › Data. The stores already flush on the
 * sync tick; this makes that queue visible and offers a manual flush.
 */

function stateColor(state: OutboxState, dark: boolean): string {
  switch (state) {
    case "blocked":
      return RED;
    case "sending":
      return INFO;
    case "retrying":
      return "#B05E14";
    case "sent":
      return GREEN;
    default:
      // Queued is inked, not semantic — white in dark so the pill stays legible
      // (hex on purpose: callers append an alpha suffix for the tint fill).
      return dark ? "#FFFFFF" : SLATE;
  }
}

function kindIcon(kind: OutboxItem["kind"]): keyof typeof MaterialCommunityIcons.glyphMap {
  switch (kind) {
    case "close":
      return "check-circle-outline";
    case "photo":
      return "camera-outline";
    default:
      return "pencil-outline";
  }
}

export default function Outbox() {
  const { t } = useTranslation();
  const router = useRouter();
  const dark = useColorScheme().colorScheme === "dark";
  const ink = dark ? "#FFFFFF" : NAVY;
  const muted = dark ? "rgba(255,255,255,0.5)" : MUTED;
  const token = useConfig((s) => s.token);
  const baseUrl = useConfig((s) => s.baseUrl);

  const closes = usePendingCloses((s) => s.pending);
  const edits = usePendingEdits((s) => s.pending);
  const photos = useWorkOrderPhotos((s) => s.pending);
  const photosSyncing = useWorkOrderPhotos((s) => s.syncing);
  const workOrders = useWorkOrders((s) => s.workOrders);

  const [flushing, setFlushing] = useState(false);

  // workOrderId → "#number · unit", so a row names the job, not a UUID.
  const woLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workOrders) {
      const number = w.number ? `#${w.number}` : "";
      const unit = w.unit_number ?? "";
      m.set(w.resman_work_order_id, [number, unit].filter(Boolean).join(" · "));
    }
    return m;
  }, [workOrders]);

  const items = useMemo(
    () =>
      buildOutbox({
        closes: Object.values(closes),
        edits: Object.values(edits),
        photos,
        photosSyncing,
      }),
    [closes, edits, photos, photosSyncing],
  );
  const pending = outboxPendingCount(items);

  const itemTitle = (item: OutboxItem): string => {
    if (item.kind === "close") return t("outbox.item.markedComplete");
    if (item.kind === "photo") return t("outbox.item.photos", { count: item.photoCount ?? 1 });
    const fields = (item.editFields ?? []).map((f) => t(`outbox.field.${f}`));
    if (fields.length === 0) return t("outbox.item.markedComplete");
    const joined = fields.join(" · ");
    return joined.charAt(0).toUpperCase() + joined.slice(1);
  };

  const onFlush = async () => {
    if (flushing) return;
    setFlushing(true);
    const config = { baseUrl, token };
    // Closes and edits first, then photos — the same order the sync tick uses,
    // so a photo's work order exists on the server before its bytes arrive.
    await usePendingCloses
      .getState()
      .flush(config)
      .catch(() => {});
    // A manual "Sync now" retries edits ResMan refused too. The automatic
    // flush skips them (the same bytes get the same verdict), but the guards
    // read ResMan-side state the office can change — so the one moment worth
    // asking again is when a human deliberately asks.
    await usePendingEdits
      .getState()
      .flush(config, { includeBlocked: true })
      .catch(() => {});
    await useWorkOrderPhotos
      .getState()
      .flush(config)
      .catch(() => {});
    setFlushing(false);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 40 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={10}
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="chevron-back" size={20} color={ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text className="text-navy dark:text-white" style={{ fontSize: 24, fontWeight: "700" }}>
            {t("outbox.title")}
          </Text>
          <Text className="text-slate dark:text-white/60" style={{ fontSize: 12.5, marginTop: 1 }}>
            {pending > 0 ? t("outbox.waiting", { count: pending }) : t("outbox.allDelivered")}
          </Text>
        </View>
        {pending > 0 ? (
          <Pressable
            onPress={onFlush}
            accessibilityRole="button"
            disabled={flushing}
            style={{ opacity: flushing ? 0.5 : 1, paddingHorizontal: 6, paddingVertical: 8 }}
          >
            <Text style={{ fontSize: 13, fontWeight: "800", color: "#767B24" }}>
              {flushing ? t("outbox.sending") : t("outbox.syncNow")}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* Reassurance — the whole point of the screen. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          marginTop: 14,
          marginBottom: 4,
        }}
      >
        <MaterialCommunityIcons name="shield-check-outline" size={18} color={GREEN} />
        <Text
          className="text-slate dark:text-white/70"
          style={{ flex: 1, fontSize: 12.5, fontWeight: "600" }}
        >
          <Text className="text-navy dark:text-white" style={{ fontWeight: "800" }}>
            {t("outbox.reassureLead")}{" "}
          </Text>
          {t("outbox.reassureBody")}
        </Text>
      </View>

      {items.length === 0 ? (
        <AppCardSurface
          kind="panel"
          style={{ paddingVertical: 28, alignItems: "center", marginTop: 14 }}
        >
          <MaterialCommunityIcons name="tray-remove" size={30} color={muted} />
          <Text
            className="text-navy dark:text-white"
            style={{ fontSize: 14, fontWeight: "800", marginTop: 10 }}
          >
            {t("outbox.emptyTitle")}
          </Text>
          <Text className="text-muted dark:text-white/50" style={{ fontSize: 12, marginTop: 3 }}>
            {t("outbox.emptyBody")}
          </Text>
        </AppCardSurface>
      ) : (
        <View style={{ marginTop: 12, gap: 9 }}>
          {items.map((item) => (
            <AppCardSurface
              key={item.id}
              kind="panel"
              style={{
                paddingHorizontal: 14,
                paddingVertical: 13,
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 12,
                borderLeftWidth: item.state === "retrying" || item.state === "blocked" ? 3.5 : 0,
                borderLeftColor: item.state === "blocked" ? RED : AMBER,
              }}
            >
              <View
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 11,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: `${stateColor(item.state, dark)}1A`,
                }}
              >
                <MaterialCommunityIcons
                  name={kindIcon(item.kind)}
                  size={19}
                  color={stateColor(item.state, dark)}
                />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  className="text-navy dark:text-white"
                  style={{ fontSize: 14, fontWeight: "800" }}
                >
                  {itemTitle(item)}
                </Text>
                <Text
                  className="text-muted dark:text-white/50"
                  style={{ fontSize: 11.5, marginTop: 2, fontWeight: "600" }}
                  numberOfLines={1}
                >
                  {woLabel.get(item.workOrderId) ?? t("outbox.workOrderFallback")}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 5,
                      paddingHorizontal: 9,
                      paddingVertical: 3.5,
                      borderRadius: 999,
                      backgroundColor: `${stateColor(item.state, dark)}1A`,
                    }}
                  >
                    {item.state === "sent" ? (
                      <Ionicons name="checkmark" size={11} color={stateColor(item.state, dark)} />
                    ) : null}
                    <Text
                      style={{
                        fontSize: 10.5,
                        fontWeight: "800",
                        color: stateColor(item.state, dark),
                      }}
                    >
                      {t(`outbox.state.${item.state}`)}
                    </Text>
                  </View>
                  {item.attempts > 1 && item.state !== "sent" ? (
                    <Text
                      className="text-muted dark:text-white/50"
                      style={{ fontSize: 10.5, fontWeight: "700" }}
                    >
                      {t("outbox.attempts", { count: item.attempts })}
                    </Text>
                  ) : null}
                </View>
                {item.lastError ? (
                  <Text
                    style={{ fontSize: 10.5, color: "#B3261E", marginTop: 5 }}
                    numberOfLines={3}
                  >
                    {item.lastError}
                  </Text>
                ) : null}
              </View>
            </AppCardSurface>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
