import { Alert, Modal, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useAnnotations, type MapAnnotation } from "@/lib/stores/annotations";
import { UTILITY_COLORS } from "@/lib/utility-lines";

/**
 * Minimal action dialog for an existing utility pin or drawn run — the
 * utility layer's counterpart to AnnotationEditorDialog, pared down to what a
 * tech needs in the field: see what it is, delete it if it's wrong. Deletion
 * follows the pin flow (store remove → queued for the server round-trip).
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

  const utilityType = annotation.utilityType ?? "other";
  const color = UTILITY_COLORS[utilityType];
  const kindLabel =
    annotation.kind === "utility_line" ? t("utility.utilityLine") : t("utility.utilityPin");

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
                {kindLabel}
              </Text>
              <Text className="text-slate dark:text-white/60" style={{ fontSize: 12, marginTop: 1 }}>
                {t(`utility.types.${utilityType}`)}
              </Text>
            </View>
          </View>

          <View className="flex-row items-center" style={{ gap: 18, justifyContent: "flex-end" }}>
            <Pressable onPress={confirmDelete} accessibilityRole="button">
              <Text style={{ color: "#D1382E", fontSize: 15, fontWeight: "700" }}>
                {t("utility.delete")}
              </Text>
            </Pressable>
            <Pressable onPress={onClose} accessibilityRole="button">
              <Text className="text-olive-dark" style={{ fontSize: 15, fontWeight: "700" }}>
                {t("utility.close")}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
