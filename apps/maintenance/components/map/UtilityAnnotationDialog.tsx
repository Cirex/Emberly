import { Alert, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useAnnotations, type MapAnnotation } from "@/lib/stores/annotations";
import { UTILITY_COLORS, effectiveLineStyle, effectiveLineWeight } from "@/lib/utility-lines";
import { FlowRow, StyleRow, WeightRow } from "@/components/map/UtilityStyleControls";

const MUTED = "#70788F";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{ fontSize: 10, fontWeight: "800", letterSpacing: 1, color: MUTED }}>
      {children.toUpperCase()}
    </Text>
  );
}

/**
 * Inspector for an existing utility pin or drawn run. A pin stays the simple
 * card it was (see what it is, delete it); a RUN is fully editable — label
 * (rides `title`), line style, weight, flow arrows, direction — every change
 * applied optimistically through the store and queued for sync, same as pins.
 */
export function UtilityAnnotationDialog({
  annotation,
  onClose,
}: {
  annotation: MapAnnotation;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const remove = useAnnotations((s) => s.remove);
  const update = useAnnotations((s) => s.update);

  const utilityType = annotation.utilityType ?? "other";
  const color = UTILITY_COLORS[utilityType];
  const isLine = annotation.kind === "utility_line";
  const kindLabel = isLine ? t("utility.utilityLine") : t("utility.utilityPin");

  const confirmDelete = () => {
    Alert.alert(t("utility.deleteTitle"), t("utility.deleteMessage"), [
      { text: t("utility.cancel"), style: "cancel" },
      {
        text: t("utility.delete"),
        style: "destructive",
        onPress: () => {
          remove(annotation.id);
          onClose();
        },
      },
    ]);
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: "rgba(9,27,84,0.32)",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        {/* Pressable-in-Pressable: taps inside the card must not dismiss. */}
        <Pressable
          onPress={() => {}}
          className="bg-white dark:bg-night-surface"
          style={{ width: "100%", maxWidth: 360, borderRadius: 22, padding: 22, gap: 14 }}
        >
          <View className="flex-row items-center" style={{ gap: 10 }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: color }} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text className="text-navy dark:text-white" style={{ fontSize: 17, fontWeight: "700" }}>
                {isLine && annotation.title.trim() ? annotation.title : kindLabel}
              </Text>
              <Text className="text-slate dark:text-white/60" style={{ fontSize: 12, marginTop: 1 }}>
                {t(`utility.types.${utilityType}`)}
                {isLine && annotation.points
                  ? ` · ${t("utility.pointCount", { count: annotation.points.length })}`
                  : ""}
              </Text>
            </View>
          </View>

          {isLine ? (
            <>
              <View style={{ gap: 6 }}>
                <SectionLabel>{t("utility.labelSection")}</SectionLabel>
                <TextInput
                  value={annotation.title}
                  onChangeText={(title) => update(annotation.id, { title })}
                  placeholder={t("utility.labelPlaceholder")}
                  placeholderTextColor="rgba(112,120,143,0.6)"
                  className="text-navy dark:text-white"
                  style={{
                    borderWidth: 1,
                    borderColor: "rgba(9,27,84,0.15)",
                    borderRadius: 10,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                />
              </View>

              <View style={{ gap: 6 }}>
                <SectionLabel>{t("utility.lineSection")}</SectionLabel>
                <View className="flex-row items-center" style={{ gap: 8, flexWrap: "wrap" }}>
                  <StyleRow
                    value={effectiveLineStyle(annotation)}
                    color={color}
                    onChange={(lineStyle) => update(annotation.id, { lineStyle })}
                  />
                  <WeightRow
                    value={effectiveLineWeight(annotation)}
                    onChange={(lineWeight) => update(annotation.id, { lineWeight })}
                  />
                </View>
              </View>

              <View style={{ gap: 6 }}>
                <SectionLabel>{t("utility.flowSection")}</SectionLabel>
                <FlowRow
                  arrows={!!annotation.flowArrows}
                  onToggle={(flowArrows) => update(annotation.id, { flowArrows })}
                  onReverse={
                    annotation.points && annotation.points.length >= 2
                      ? () => update(annotation.id, { points: [...annotation.points!].reverse() })
                      : undefined
                  }
                />
              </View>
            </>
          ) : null}

          <View className="flex-row items-center" style={{ gap: 18, justifyContent: "flex-end" }}>
            <Pressable onPress={confirmDelete} accessibilityRole="button">
              <Text style={{ color: "#D1382E", fontSize: 15, fontWeight: "700" }}>
                {isLine ? t("utility.deleteRun") : t("utility.delete")}
              </Text>
            </Pressable>
            <Pressable onPress={onClose} accessibilityRole="button">
              <Text className="text-olive-dark" style={{ fontSize: 15, fontWeight: "700" }}>
                {t("utility.done")}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
