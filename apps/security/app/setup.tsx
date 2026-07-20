import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { checkScannerKey } from "@/lib/api/scanner";
import { EmberlyBrandLogo } from "@emberly/ui";
import { capture } from "@/lib/analytics";
import { isScannerConfigured, useConfig } from "@/lib/stores/config";

/** Width of the reveal button, mirrored as a spacer on the other side. */
const REVEAL_HIT_WIDTH = 24;

/**
 * The single place this device is configured, and the only thing to configure is
 * the access key — the origin is fixed at build time. One key authorizes every
 * view, so there is no per-view setup.
 *
 * Reached two ways: as the gate when the device has no key yet (the root layout
 * withholds the tabs until it does), or pushed from a settings button to replace
 * an existing key — hence the Cancel affordance only when there is somewhere to
 * return to.
 */
export default function Setup() {
  const router = useRouter();
  const config = useConfig();
  const [scannerKey, setScannerKey] = useState(config.scannerKey);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Re-sync once the secure store has hydrated.
  useEffect(() => {
    setScannerKey(config.scannerKey);
  }, [config.hydrated]);

  const alreadySetUp = isScannerConfigured(config);
  const canSave = scannerKey.trim().length > 0 && !saving;

  const onSave = async () => {
    setError("");
    setSaving(true);

    // Prove the key before storing it. Saving first would open the gate and let a
    // bad key fail on every screen behind it instead of here, where it can be
    // corrected.
    const check = await checkScannerKey({ baseUrl: config.baseUrl, scannerKey: scannerKey.trim() });
    if (!check.ok) {
      setSaving(false);
      setError(
        check.reason === "rejected"
          ? "That key wasn’t accepted. Check it and try again."
          : "Can’t reach the server. Check the network connection and try again.",
      );
      return;
    }

    await config.save({ scannerKey });
    // No PII: just whether this was a first-time setup or a key replacement.
    capture("scanner_configured", { reconfigured: alreadySetUp });
    setSaving(false);
    // Replacing a key returns where it came from; the first-run gate has nowhere
    // to go back to, so hand off to the tabs the root layout just added.
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  };

  return (
    <SafeAreaView className="flex-1">
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View
            className="bg-white"
            style={{
              width: "100%",
              maxWidth: 500,
              borderRadius: 28,
              paddingHorizontal: 32,
              paddingVertical: 40,
              alignItems: "center",
              gap: 22,
              // Lifts the card off the workspace backdrop.
              shadowColor: "#091B54",
              shadowOpacity: 0.1,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: 8 },
              elevation: 4,
            }}
          >
            <EmberlyBrandLogo variant="full" size={104} />

            <View style={{ alignItems: "center", gap: 8 }}>
              <Text
                className="text-navy"
                style={{ fontSize: 22, fontWeight: "700", textAlign: "center" }}
              >
                Activate this device
              </Text>
              <Text
                className="text-muted"
                style={{ fontSize: 15, lineHeight: 21, textAlign: "center" }}
              >
                Enter access key to unlock this Application
              </Text>
            </View>

            <View style={{ width: "100%", gap: 8 }}>
              <View
                className="bg-white"
                style={{
                  height: 52,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: "rgba(9,27,84,0.18)",
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                }}
              >
                {/* Balances the reveal button so the centered text stays centered. */}
                <View style={{ width: REVEAL_HIT_WIDTH }} />
                <TextInput
                  value={scannerKey}
                  onChangeText={(t) => {
                    setScannerKey(t);
                    if (error) setError("");
                  }}
                  placeholder="Access key"
                  placeholderTextColor="rgba(112,120,143,0.6)"
                  secureTextEntry={!revealed}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="go"
                  onSubmitEditing={() => canSave && onSave()}
                  className="text-navy"
                  style={{ flex: 1, fontSize: 16, paddingVertical: 0, textAlign: "center" }}
                />
                <Pressable
                  onPress={() => setRevealed((v) => !v)}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel={revealed ? "Hide access key" : "Show access key"}
                  style={{ width: REVEAL_HIT_WIDTH, alignItems: "flex-end" }}
                >
                  <Ionicons
                    name={revealed ? "eye-off-outline" : "eye-outline"}
                    size={20}
                    color="#70788F"
                  />
                </Pressable>
              </View>
              {error ? (
                <Text
                  style={{ color: "#B3261E", fontSize: 13, lineHeight: 18, textAlign: "center" }}
                >
                  {error}
                </Text>
              ) : null}
            </View>

            <Pressable
              onPress={onSave}
              disabled={!canSave}
              className="bg-olive"
              style={{
                width: "100%",
                height: 52,
                borderRadius: 14,
                alignItems: "center",
                justifyContent: "center",
                opacity: canSave ? 1 : 0.5,
              }}
            >
              <Text style={{ color: "#0B1020", fontSize: 16, fontWeight: "700" }}>
                {saving ? "Activating…" : "Activate"}
              </Text>
            </Pressable>

            {alreadySetUp && router.canGoBack() ? (
              <Pressable onPress={() => router.back()} hitSlop={10}>
                <Text className="text-slate" style={{ fontSize: 15, fontWeight: "600" }}>
                  Cancel
                </Text>
              </Pressable>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
