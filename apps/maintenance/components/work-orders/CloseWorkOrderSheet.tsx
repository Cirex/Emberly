import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Image, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { capture } from "@/lib/analytics";
import { MUTED, NAVY } from "@/theme/tokens";
import { useAccentPalette } from "@/lib/hooks/use-accent";

const THUMB = 84;

/**
 * Bottom-sheet confirmation for closing a work order, grown from the old
 * Alert: the tech can attach completion photos (camera or library, same
 * picker + JPEG compression as the annotation photo flow) before confirming.
 * Photos are optional — Mark complete with none behaves exactly as before.
 * The sheet only holds picker-cache URIs; the caller copies them into the
 * offline queue (lib/stores/work-order-photos.ts) on confirm.
 */
export function CloseWorkOrderSheet({
  visible,
  workOrderId,
  number,
  unitNumber,
  dark,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  workOrderId: string;
  number: string;
  unitNumber: string;
  dark: boolean;
  /** Fired with the attached photo URIs (possibly empty) when confirmed. */
  onConfirm: (photoUris: string[]) => void;
  onClose: () => void;
}) {
  const palette = useAccentPalette();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [photos, setPhotos] = useState<string[]>([]);
  // Re-seed per open so a dismissed sheet doesn't resurrect old drafts.
  const [seeded, setSeeded] = useState(false);
  if (visible && !seeded) {
    setPhotos([]);
    setSeeded(true);
  } else if (!visible && seeded) {
    setSeeded(false);
  }

  const sheetBg = dark ? "#1C2129" : "#FCFAF4";
  const ink = dark ? "#FFFFFF" : NAVY;

  const pickPhoto = () => {
    const attach = async (result: ImagePicker.ImagePickerResult) => {
      const uri = result.assets?.[0]?.uri;
      if (result.canceled || !uri) return;
      setPhotos((prev) => [...prev, uri]);
      // No PII: internal work-order id + machine phase only.
      capture("completion_photo_captured", { workOrderId, phase: "completion" });
    };
    Alert.alert(t("workOrders.closeFlow.addPhoto"), undefined, [
      {
        text: t("workOrders.closeFlow.takePhoto"),
        onPress: () => void ImagePicker.launchCameraAsync({ quality: 0.7 }).then(attach),
      },
      {
        text: t("workOrders.closeFlow.chooseFromLibrary"),
        onPress: () =>
          void ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 }).then(
            attach,
          ),
      },
      { text: t("workOrders.closeFlow.cancel"), style: "cancel" },
    ]);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(9,27,84,0.30)" }}
        onPress={onClose}
        accessibilityLabel={t("workOrders.closeFlow.cancel")}
      />
      <View
        style={{
          backgroundColor: sheetBg,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          paddingTop: 8,
          paddingBottom: insets.bottom + 12,
        }}
      >
        <View style={{ alignItems: "center" }}>
          <View
            style={{
              width: 36,
              height: 4.5,
              borderRadius: 3,
              backgroundColor: dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.14)",
            }}
          />
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 14, gap: 3 }}>
          <Text style={{ fontSize: 17, fontWeight: "800", color: ink, letterSpacing: -0.3 }}>
            {t("workOrders.closeFlow.title")}
          </Text>
          <Text style={{ fontSize: 12.5, fontWeight: "600", color: MUTED }}>
            {t("workOrders.closeFlow.subtitle", { number, unit: unitNumber })}
          </Text>
        </View>

        {/* Completion photos — optional, capped visually by the scroll row. */}
        <View style={{ paddingTop: 16, gap: 8 }}>
          <View style={{ paddingHorizontal: 20 }}>
            <Text style={{ fontSize: 9.5, fontWeight: "800", letterSpacing: 0.9, color: MUTED }}>
              {t("workOrders.closeFlow.photosLabel").toUpperCase()}
            </Text>
            <Text style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
              {t("workOrders.closeFlow.photosHint")}
            </Text>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 10, paddingHorizontal: 20, paddingTop: 7 }}
          >
            {photos.map((uri, index) => (
              <View key={`${index}-${uri}`} style={{ width: THUMB, height: THUMB }}>
                <Image
                  source={{ uri }}
                  style={{ width: THUMB, height: THUMB, borderRadius: 12 }}
                  resizeMode="cover"
                />
                <Pressable
                  onPress={() => setPhotos((prev) => prev.filter((_, i) => i !== index))}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t("workOrders.closeFlow.removePhoto")}
                  style={{ position: "absolute", top: -7, right: -7 }}
                >
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 11,
                      backgroundColor: "#FFFFFF",
                      alignItems: "center",
                      justifyContent: "center",
                      shadowColor: "#000",
                      shadowOpacity: 0.2,
                      shadowRadius: 3,
                      shadowOffset: { width: 0, height: 1 },
                    }}
                  >
                    <Ionicons name="close" size={14} color="#D1382E" />
                  </View>
                </Pressable>
              </View>
            ))}
            <Pressable
              onPress={pickPhoto}
              accessibilityRole="button"
              accessibilityLabel={t("workOrders.closeFlow.addPhoto")}
            >
              <View
                style={{
                  width: THUMB,
                  height: THUMB,
                  borderRadius: 12,
                  borderWidth: 1.5,
                  borderStyle: "dashed",
                  borderColor: dark ? "rgba(255,255,255,0.25)" : "rgba(9,27,84,0.25)",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 3,
                }}
              >
                <Ionicons name="camera" size={22} color={MUTED} />
                <Text style={{ fontSize: 11, fontWeight: "600", color: MUTED }}>
                  {t("workOrders.closeFlow.add")}
                </Text>
              </View>
            </Pressable>
          </ScrollView>
        </View>

        {/* Cancel · Mark complete */}
        <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 20, paddingTop: 18 }}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            style={{
              flex: 1,
              height: 46,
              borderRadius: 999,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: dark ? "rgba(255,255,255,0.08)" : "rgba(9,27,84,0.06)",
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "700", color: ink, letterSpacing: -0.1 }}>
              {t("workOrders.closeFlow.cancel")}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => onConfirm(photos)}
            accessibilityRole="button"
            style={{
              flex: 1.35,
              height: 46,
              borderRadius: 999,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              backgroundColor: palette.text,
            }}
          >
            <Ionicons name="checkmark" size={16} color="#FFFFFF" />
            <Text style={{ fontSize: 13, fontWeight: "700", color: "#FFFFFF", letterSpacing: -0.1 }}>
              {t("workOrders.closeFlow.confirm")}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
