import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { capture as track } from "@/lib/analytics";
import { useConfig } from "@/lib/stores/config";
import { usePhotoQueue } from "@/lib/stores/photo-queue";

const OLIVE = "#B4B925";

export default function PhotoCapture() {
  const { entryLogId } = useLocalSearchParams<{ entryLogId: string }>();
  const router = useRouter();
  const config = useConfig();
  const enqueue = usePhotoQueue((s) => s.enqueue);
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [uri, setUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const capture = async () => {
    setBusy(true);
    const photo = await cameraRef.current?.takePictureAsync({ quality: 0.6 });
    setBusy(false);
    if (photo?.uri) setUri(photo.uri);
  };

  const confirm = async () => {
    if (uri && entryLogId) {
      await enqueue(entryLogId, uri, config);
      // No PII: just that a photo was attached to an entry log.
      track("entry_photo_captured");
    } else {
      track("entry_photo_skipped");
    }
    router.back();
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#0B0D12" }}>
      {!uri ? (
        permission?.granted ? (
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
        ) : null
      ) : (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
      )}

      <SafeAreaView style={{ flex: 1, justifyContent: "space-between" }}>
        {/* Header */}
        <View className="flex-row items-center justify-between" style={{ padding: 18 }}>
          <Text style={{ color: "#FFFFFF", fontSize: 18, fontWeight: "700" }}>Entry photo</Text>
          <Pressable onPress={() => { track("entry_photo_skipped"); router.back(); }} hitSlop={10}>
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </Pressable>
        </View>

        {/* Footer controls */}
        <View style={{ padding: 24, alignItems: "center", gap: 16 }}>
          {!permission?.granted ? (
            <Pressable onPress={requestPermission} style={ctaStyle}>
              <Text style={ctaText}>Enable Camera</Text>
            </Pressable>
          ) : !uri ? (
            <Pressable
              onPress={capture}
              disabled={busy}
              accessibilityLabel="Take photo"
              style={{
                width: 74,
                height: 74,
                borderRadius: 999,
                borderWidth: 5,
                borderColor: "rgba(255,255,255,0.9)",
                backgroundColor: OLIVE,
                opacity: busy ? 0.6 : 1,
              }}
            />
          ) : (
            <View className="flex-row" style={{ gap: 12, width: "100%" }}>
              <Pressable onPress={() => setUri(null)} style={[ctaStyle, ghost]}>
                <Text style={[ctaText, { color: "#FFFFFF" }]}>Retake</Text>
              </Pressable>
              <Pressable onPress={confirm} style={[ctaStyle, { backgroundColor: OLIVE, flex: 1 }]}>
                <Text style={ctaText}>Use Photo</Text>
              </Pressable>
            </View>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const ctaStyle = {
  height: 50,
  paddingHorizontal: 24,
  borderRadius: 14,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: OLIVE,
} as const;
const ghost = {
  backgroundColor: "rgba(255,255,255,0.1)",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.28)",
} as const;
const ctaText = { color: "#0B1020", fontSize: 16, fontWeight: "700" } as const;
