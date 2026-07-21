import { Ionicons } from "@expo/vector-icons";
import { Alert, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAnnotations, type MapAnnotation } from "@/lib/stores/annotations";
import { UTILITY_COLORS, effectiveLineStyle, effectiveLineWeight } from "@/lib/utility-lines";
import { FlowRow, StyleRow, WeightRow } from "@/components/map/UtilityStyleControls";
import { activeLocale } from "@/lib/i18n";

const NAVY = "#091B54";
const MUTED = "#70788F";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{ fontSize: 9, fontWeight: "800", letterSpacing: 1, color: MUTED }}>
      {children.toUpperCase()}
    </Text>
  );
}

/**
 * Inspector for an existing utility pin or drawn run — the approved mockup's
 * bottom sheet. A RUN is fully editable: label (rides `title`), line style,
 * weight, flow arrows, direction — every change applied optimistically
 * through the store and queued for sync. A pin keeps the sheet minimal:
 * see what it is, delete it.
 */
export function UtilityAnnotationDialog({
  annotation,
  onClose,
}: {
  annotation: MapAnnotation;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const remove = useAnnotations((s) => s.remove);
  const update = useAnnotations((s) => s.update);

  const utilityType = annotation.utilityType ?? "other";
  const color = UTILITY_COLORS[utilityType];
  const isLine = annotation.kind === "utility_line";
  const kindLabel = isLine ? t("utility.utilityLine") : t("utility.utilityPin");

  // "Water · 4 points · added by Quinn H. on Jul 14" — segments drop out when
  // the row has no provenance (local-only or an older server).
  const meta = [
    t(`utility.types.${utilityType}`),
    isLine && annotation.points ? t("utility.pointCount", { count: annotation.points.length }) : null,
    annotation.createdBy
      ? t("utility.addedBy", {
          name: annotation.createdBy,
          date: annotation.createdAt
            ? new Date(annotation.createdAt).toLocaleDateString(activeLocale(), { month: "short", day: "numeric" })
            : "",
        }).trim()
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(9,27,84,0.30)", justifyContent: "flex-end" }}>
        <Pressable style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }} onPress={onClose} />
        <View
          style={{
            backgroundColor: "rgba(250,247,240,0.99)",
            borderTopLeftRadius: 22,
            borderTopRightRadius: 22,
            paddingBottom: insets.bottom + 14,
          }}
        >
          <View style={{ alignItems: "center", paddingTop: 8 }}>
            <View style={{ width: 34, height: 4, borderRadius: 2, backgroundColor: "rgba(9,27,84,0.16)" }} />
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, paddingTop: 10 }}>
            <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: color }} />
            <Text style={{ flex: 1, fontSize: 16, fontWeight: "800", letterSpacing: -0.3, color: NAVY }} numberOfLines={1}>
              {isLine && annotation.title.trim() ? annotation.title : kindLabel}
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t("utility.close")}
              style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(9,27,84,0.06)", alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name="close" size={13} color="#4C556F" />
            </Pressable>
          </View>
          <Text style={{ paddingHorizontal: 18, paddingTop: 3, fontSize: 10.5, color: MUTED }}>{meta}</Text>

          {isLine ? (
            <View style={{ paddingHorizontal: 18, paddingTop: 12, gap: 12 }}>
              <View style={{ gap: 6 }}>
                <SectionLabel>{t("utility.labelSection")}</SectionLabel>
                <TextInput
                  value={annotation.title}
                  onChangeText={(title) => update(annotation.id, { title })}
                  placeholder={t("utility.labelPlaceholder")}
                  placeholderTextColor="rgba(112,120,143,0.6)"
                  style={{
                    borderWidth: 1,
                    borderColor: "rgba(9,27,84,0.15)",
                    borderRadius: 10,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    fontSize: 13,
                    fontWeight: "600",
                    color: NAVY,
                    backgroundColor: "#FBF9F1",
                  }}
                />
              </View>

              <View style={{ gap: 6 }}>
                <SectionLabel>{t("utility.lineSection")}</SectionLabel>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
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
            </View>
          ) : null}

          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingTop: 16 }}>
            <Pressable
              onPress={confirmDelete}
              accessibilityRole="button"
              style={{ borderRadius: 999, paddingHorizontal: 15, paddingVertical: 8, backgroundColor: "rgba(192,57,43,0.09)" }}
            >
              <Text style={{ color: "#C0392B", fontSize: 12, fontWeight: "800" }}>
                {isLine ? t("utility.deleteRun") : t("utility.delete")}
              </Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              style={{ borderRadius: 999, paddingHorizontal: 18, paddingVertical: 8, backgroundColor: "rgba(162,169,33,0.92)" }}
            >
              <Text style={{ color: "#FFFFFF", fontSize: 12, fontWeight: "800" }}>{t("utility.done")}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
