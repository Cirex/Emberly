import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScannerResultCard } from "@/components/scanner/ScannerResultCard";
import { useConfig } from "@/lib/stores/config";
import { usePhotoQueue } from "@/lib/stores/photo-queue";
import { useScanner } from "@/lib/stores/scanner";

const OLIVE = "#B4B925";

export default function ScannerScreen() {
  const router = useRouter();
  const config = useConfig();
  const photoQueue = usePhotoQueue();
  const { phase, result, errorMessage, recent, verify, reset } = useScanner();
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => {
    if (!photoQueue.hydrated) void photoQueue.hydrate();
  }, [photoQueue]);

  // Retry any queued entry photos on mount.
  useEffect(() => {
    if (config.hydrated) void photoQueue.flush(config);
  }, [config.hydrated]);

  const scanning = phase === "scanning";
  const openSettings = () => router.push("/settings");
  const addPhoto = (entryLogId: string) =>
    router.push({ pathname: "/photo-capture", params: { entryLogId } });

  return (
    <View style={{ flex: 1, backgroundColor: "#0B0D12" }}>
      {/* Live camera (only while scanning + permitted) */}
      {permission?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={scanning ? ({ data }) => verify(data, config) : undefined}
        />
      ) : null}

      {/* Dark scrim for legibility */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(6,8,14,0.35)" }]}
      />

      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        {/* Header */}
        <View className="flex-row items-center justify-between" style={{ paddingHorizontal: 20, paddingTop: 8 }}>
          <Text style={{ color: "#FFFFFF", fontSize: 19, fontWeight: "600" }}>
            {scanning ? "Scan a pass" : phase === "verifying" ? "Verifying…" : "Result"}
          </Text>
          <Pressable
            onPress={openSettings}
            accessibilityLabel="Scanner settings"
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.16)",
              backgroundColor: "rgba(255,255,255,0.08)",
            }}
          >
            <Ionicons name="settings-outline" size={20} color="#FFFFFF" />
          </Pressable>
        </View>

        {/* Body */}
        <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 20 }}>
          {!permission?.granted ? (
            <Prompt
              icon="camera-outline"
              title="Camera access needed"
              body="Emberly Security uses the camera to scan resident and guest passes."
              cta="Enable Camera"
              onPress={requestPermission}
            />
          ) : scanning ? (
            <>
              <ScanFrame />
              <Text
                style={{
                  color: "rgba(255,255,255,0.86)",
                  fontSize: 16,
                  textAlign: "center",
                  marginTop: 28,
                }}
              >
                Center the pass QR code in the frame
              </Text>
            </>
          ) : phase === "verifying" ? (
            <ScanFrame verifying />
          ) : (
            <ScannerResultCard
              phase={phase}
              result={result}
              errorMessage={errorMessage}
              onScanAnother={reset}
              onConfigure={() => router.push("/setup")}
              onAddPhoto={addPhoto}
            />
          )}
        </View>

        {/* Recent scans */}
        {scanning && recent.length > 0 ? (
          <View style={{ paddingHorizontal: 20, paddingBottom: 96 }}>
            <Text
              style={{ color: "rgba(255,255,255,0.55)", fontSize: 12, fontWeight: "700", letterSpacing: 1, marginBottom: 8 }}
            >
              RECENT
            </Text>
            <View style={{ gap: 6 }}>
              {recent.slice(0, 3).map((r) => (
                <View key={r.id} className="flex-row items-center" style={{ gap: 8 }}>
                  <Ionicons
                    name={r.ok ? "checkmark-circle" : "close-circle"}
                    size={16}
                    color={r.ok ? OLIVE : "#D12E21"}
                  />
                  <Text style={{ color: "rgba(255,255,255,0.8)", fontSize: 14 }}>{r.name}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

function ScanFrame({ verifying }: { verifying?: boolean }) {
  return (
    <View style={{ alignItems: "center" }}>
      <View
        style={{
          width: 240,
          height: 240,
          borderRadius: 40,
          borderWidth: 2,
          borderColor: verifying ? OLIVE : "rgba(255,255,255,0.5)",
          backgroundColor: "rgba(255,255,255,0.04)",
        }}
      />
    </View>
  );
}

function Prompt({
  icon,
  title,
  body,
  cta,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  body: string;
  cta: string;
  onPress: () => void;
}) {
  return (
    <View
      style={{
        borderRadius: 28,
        padding: 26,
        alignItems: "center",
        gap: 12,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.12)",
        backgroundColor: "rgba(18,20,26,0.9)",
      }}
    >
      <Ionicons name={icon} size={40} color={OLIVE} />
      <Text style={{ color: "#FFFFFF", fontSize: 18, fontWeight: "700" }}>{title}</Text>
      <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 15, textAlign: "center" }}>{body}</Text>
      <Pressable
        onPress={onPress}
        style={{
          height: 46,
          paddingHorizontal: 22,
          borderRadius: 999,
          backgroundColor: OLIVE,
          alignItems: "center",
          justifyContent: "center",
          marginTop: 6,
        }}
      >
        <Text style={{ color: "#0B1020", fontSize: 15, fontWeight: "700" }}>{cta}</Text>
      </Pressable>
    </View>
  );
}
