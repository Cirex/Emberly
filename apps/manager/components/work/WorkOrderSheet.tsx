import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chip, DetailRow } from "@/components/work/primitives";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE, MUTED, NAVY } from "@/theme/tokens";
import type { ParsedWorkOrder } from "@emberly/core";

/**
 * Read-only work-order detail. The manager app is an oversight surface: this
 * sheet shows the full description, notes, dates, technician and signals, and
 * deliberately carries NO close/reassign controls — those live in the
 * maintenance app, which owns the writes.
 */

function dateLabel(ms: number | null): string | null {
  if (ms === null) return null;
  return new Date(ms).toLocaleDateString(activeLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function WorkOrderSheet({
  order,
  onClose,
}: {
  order: ParsedWorkOrder | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const none = t("work.detail.none");

  return (
    <Modal
      visible={order !== null}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(9,27,84,0.25)" }]}
        onPress={onClose}
        accessibilityLabel={t("work.detail.close")}
      />
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: "88%",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          backgroundColor: "rgba(250,247,240,0.99)",
          shadowColor: NAVY,
          shadowOpacity: 0.12,
          shadowRadius: 30,
          shadowOffset: { width: 0, height: -8 },
          paddingBottom: Math.max(insets.bottom, 16),
        }}
      >
        <View
          style={{
            alignSelf: "center",
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: "rgba(9,27,84,0.15)",
            marginTop: 8,
          }}
        />
        {order === null ? null : (
          <>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 18,
                paddingTop: 12,
              }}
            >
              <Text
                numberOfLines={2}
                style={{ flex: 1, fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: NAVY }}
              >
                {order.title || t("work.detail.title", { number: order.number })}
              </Text>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel={t("work.detail.close")}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  backgroundColor: "rgba(9,27,84,0.06)",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name="close" size={14} color={MUTED} />
              </Pressable>
            </View>
            <Text style={{ paddingHorizontal: 18, paddingTop: 2, fontSize: 10.5, color: MUTED }}>
              {t("work.detail.title", { number: order.number || order.id })}
            </Text>

            <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 12 }}>
              {order.isDuplicate || order.callbackStatus === "possible" || order.callbackStatus === "confirmed" ? (
                <View style={{ flexDirection: "row", gap: 6, paddingTop: 10, flexWrap: "wrap" }}>
                  {order.callbackStatus === "possible" || order.callbackStatus === "confirmed" ? (
                    <Chip label={t("work.detail.callback")} tone="callback" />
                  ) : null}
                  {order.isDuplicate ? <Chip label={t("work.detail.duplicate")} tone="neutral" /> : null}
                </View>
              ) : null}

              <View style={{ paddingTop: 8 }}>
                <DetailRow label={t("work.detail.unit")} value={order.unitNumber || none} />
                <DetailRow label={t("work.detail.status")} value={order.status || none} />
                <DetailRow
                  label={t("work.detail.priority")}
                  value={t(`work.priority.${order.priority}`, order.priority || none)}
                />
                <DetailRow label={t("work.detail.category")} value={order.raw.category || none} />
                <DetailRow label={t("work.detail.technician")} value={order.technicianDisplay} />
                <DetailRow label={t("work.detail.reported")} value={dateLabel(order.reportedAt) ?? none} />
                <DetailRow label={t("work.detail.scheduled")} value={dateLabel(order.scheduledAt) ?? none} />
                <DetailRow label={t("work.detail.completed")} value={dateLabel(order.completedAt) ?? none} />
                {order.tags.length > 0 ? (
                  <DetailRow label={t("work.detail.tags")} value={order.tags.join(", ")} />
                ) : null}
              </View>

              <Text style={{ paddingTop: 14, fontSize: 10, fontWeight: "800", letterSpacing: 0.8, color: MUTED }}>
                {t("work.detail.description").toUpperCase()}
              </Text>
              <Text style={{ paddingTop: 5, fontSize: 12.5, lineHeight: 18, color: NAVY }}>
                {order.raw.notes || none}
              </Text>

              {order.raw.completion_notes ? (
                <>
                  <Text
                    style={{ paddingTop: 14, fontSize: 10, fontWeight: "800", letterSpacing: 0.8, color: MUTED }}
                  >
                    {t("work.detail.completionNotes").toUpperCase()}
                  </Text>
                  <Text style={{ paddingTop: 5, fontSize: 12.5, lineHeight: 18, color: NAVY }}>
                    {order.raw.completion_notes}
                  </Text>
                </>
              ) : null}

              <View style={{ marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: HAIRLINE }}>
                <Text style={{ fontSize: 10.5, color: MUTED }}>{t("work.detail.readOnly")}</Text>
              </View>
            </ScrollView>
          </>
        )}
      </View>
    </Modal>
  );
}
