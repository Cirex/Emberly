import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { Chip, DetailRow, type ChipTone } from "@/components/work/primitives";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE, HEADER_TOP_PAD, MUTED, NAVY, OLIVE_GLASS } from "@/theme/tokens";
import type { ParsedWorkOrder } from "@emberly/core";

/**
 * The full-page work-order detail (mockup frame 04). Replaces the old bottom
 * sheet: tapping a board row pushes THIS page in-tab, so the sidebar rail stays
 * put and the flow reads as board → order page, exactly the maintenance app's
 * two-page pattern. Still read-only — the manager app is an oversight surface;
 * the writes (close / reassign / notes / photos) live in the maintenance app.
 */

function dateLabel(ms: number | null): string | null {
  if (ms === null) return null;
  return new Date(ms).toLocaleDateString(activeLocale(), { year: "numeric", month: "short", day: "numeric" });
}

/** Priority → the chip tone shared with the board bands. */
function priorityTone(priority: string): ChipTone {
  const p = priority.toLowerCase();
  if (p === "emergency") return "emergency";
  if (p === "high") return "high";
  if (p === "low") return "low";
  return "normal";
}

/** A dot color for the unit-history rail, keyed to each order's priority. */
const HISTORY_DOT: Record<ChipTone, string> = {
  emergency: "#D1382E",
  high: "#E38736",
  normal: "#458ADB",
  low: "#70788F",
  callback: "#7A6BC7",
  blocked: "#D1382E",
  ready: "#33A666",
  neutral: "#70788F",
};

export function WorkOrderDetail({
  order,
  unitHistory,
  onBack,
  onOpenOrder,
}: {
  order: ParsedWorkOrder;
  /** Other orders on the same unit, newest first — the history rail at the foot. */
  unitHistory: ParsedWorkOrder[];
  onBack: () => void;
  onOpenOrder: (id: string) => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const none = t("work.detail.none");
  const isCallback = order.callbackStatus === "possible" || order.callbackStatus === "confirmed";

  return (
    <View style={{ flex: 1 }}>
      {/* Header: back to the board, then the order number. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingTop: insets.top + HEADER_TOP_PAD,
          paddingBottom: 12,
          paddingHorizontal: 6,
        }}
      >
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t("work.title")}
          hitSlop={8}
          style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 6, paddingHorizontal: 6 }}
        >
          <Ionicons name="chevron-back" size={20} color={OLIVE_GLASS} />
          <Text style={{ fontSize: 15, fontWeight: "700", color: OLIVE_GLASS }}>{t("work.title")}</Text>
        </Pressable>
        <Text style={{ fontSize: 15, fontWeight: "800", color: NAVY, letterSpacing: -0.2 }}>
          {t("work.detail.title", { number: order.number || order.id })}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 130 }}>
        <AppCardSurface kind="panel" style={{ paddingHorizontal: 18, paddingVertical: 16 }}>
          <Text style={{ fontSize: 19, fontWeight: "800", letterSpacing: -0.3, color: NAVY }}>
            {order.title || t("work.detail.title", { number: order.number })}
          </Text>
          {/* Chip row — status toned by priority, category, callback. */}
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            <Chip
              label={`${t(`work.priority.${order.priority}`, order.priority || "")} · ${order.status || none}`.trim()}
              tone={priorityTone(order.priority)}
            />
            {order.raw.category ? <Chip label={order.raw.category} tone="normal" /> : null}
            {isCallback ? <Chip label={t("work.detail.callback")} tone="callback" /> : null}
            {order.isDuplicate ? <Chip label={t("work.detail.duplicate")} tone="neutral" /> : null}
          </View>

          <View style={{ marginTop: 12 }}>
            <DetailRow label={t("work.detail.unit")} value={order.unitNumber || none} />
            <DetailRow label={t("work.detail.category")} value={order.raw.category || none} />
            <DetailRow label={t("work.detail.technician")} value={order.technicianDisplay} />
            <DetailRow label={t("work.detail.reported")} value={dateLabel(order.reportedAt) ?? none} />
            <DetailRow label={t("work.detail.scheduled")} value={dateLabel(order.scheduledAt) ?? none} />
            <DetailRow label={t("work.detail.completed")} value={dateLabel(order.completedAt) ?? none} />
            {order.tags.length > 0 ? <DetailRow label={t("work.detail.tags")} value={order.tags.join(", ")} /> : null}
          </View>

          <Text style={{ marginTop: 14, fontSize: 10, fontWeight: "800", letterSpacing: 0.8, color: MUTED }}>
            {t("work.detail.description").toUpperCase()}
          </Text>
          <Text style={{ marginTop: 5, fontSize: 12.5, lineHeight: 18, color: NAVY }}>{order.raw.notes || none}</Text>

          {order.raw.completion_notes ? (
            <>
              <Text style={{ marginTop: 14, fontSize: 10, fontWeight: "800", letterSpacing: 0.8, color: MUTED }}>
                {t("work.detail.completionNotes").toUpperCase()}
              </Text>
              <Text style={{ marginTop: 5, fontSize: 12.5, lineHeight: 18, color: NAVY }}>
                {order.raw.completion_notes}
              </Text>
            </>
          ) : null}

          <View style={{ marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: HAIRLINE }}>
            <Text style={{ fontSize: 10.5, color: MUTED }}>{t("work.detail.readOnly")}</Text>
          </View>
        </AppCardSurface>

        {/* Unit history rail — every other order on this unit, newest first. */}
        {unitHistory.length > 0 ? (
          <AppCardSurface kind="panel" style={{ paddingHorizontal: 16, paddingVertical: 13, marginTop: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: "800", letterSpacing: -0.2, color: NAVY }}>
                {t("work.detail.unitHistory")}
              </Text>
              <Text style={{ fontSize: 10.5, color: MUTED }}>
                {t("work.detail.unitHistoryCount", { count: unitHistory.length })}
              </Text>
            </View>
            {unitHistory.map((h, i) => (
              <Pressable
                key={h.id}
                onPress={() => onOpenOrder(h.id)}
                accessibilityRole="button"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 9,
                  paddingVertical: 8,
                  borderBottomWidth: i === unitHistory.length - 1 ? 0 : 1,
                  borderBottomColor: HAIRLINE,
                }}
              >
                <View
                  style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: HISTORY_DOT[priorityTone(h.priority)] }}
                />
                <Text style={{ fontSize: 12, fontWeight: "800", color: MUTED, fontVariant: ["tabular-nums"] }}>
                  {t("work.detail.title", { number: h.number || h.id })}
                </Text>
                <Text className="text-navy dark:text-white" numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "600" }}>
                  {h.title || none}
                </Text>
                <Text style={{ fontSize: 10.5, color: MUTED }}>{dateLabel(h.reportedAt) ?? ""}</Text>
              </Pressable>
            ))}
          </AppCardSurface>
        ) : null}
      </ScrollView>
    </View>
  );
}
