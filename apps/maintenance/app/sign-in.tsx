import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
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
import { EmberlyBrandLogo } from "@emberly/ui";
import { capture, identify } from "@/lib/analytics";
import { signInWithResman } from "@/lib/api/auth";
import { useConfig } from "@/lib/stores/config";

const REVEAL_HIT_WIDTH = 24;

const ERROR_TEXT: Record<string, string> = {
  invalid: "That username or password wasn’t accepted. Check them and try again.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  unavailable: "ResMan sign-in is temporarily unavailable. Try again shortly.",
  unreachable: "Can’t reach the server. Check the network connection and try again.",
};

/**
 * Staff sign-in: ResMan username + password, validated through the Emberly API
 * server, exchanged for a per-user token held in the Keychain. Deliberately
 * minimal — the full lockup, two fields, one button (per the approved mockup).
 *
 * Reached two ways: as the gate when nobody is signed in (the root layout
 * withholds the tabs), or pushed from Settings to switch users.
 */
export default function SignIn() {
  const router = useRouter();
  const config = useConfig();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  const onSignIn = async () => {
    setError("");
    setBusy(true);
    const result = await signInWithResman({
      baseUrl: config.baseUrl,
      username: username.trim(),
      password,
      device: `${Platform.OS === "ios" ? "iOS" : "Android"}`,
    });
    if (!result.ok) {
      setBusy(false);
      setError(ERROR_TEXT[result.reason] ?? ERROR_TEXT.unreachable);
      return;
    }
    await config.signIn({ token: result.token, admin: result.admin });
    // Tie subsequent events to the staff member by their stable admin id (no
    // name/PII), then record the sign-in with just their role.
    identify(result.admin.adminId, { role: result.admin.role });
    capture("signed_in", { role: result.admin.role });
    setBusy(false);
    // Switching users returns where it came from; the first-run gate has
    // nowhere to go back to, so hand off to the tabs the root layout just added.
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
              shadowColor: "#091B54",
              shadowOpacity: 0.1,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: 8 },
              elevation: 4,
            }}
          >
            <EmberlyBrandLogo variant="full" size={128} />

            <View style={{ width: "100%", gap: 10 }}>
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
                  gap: 10,
                }}
              >
                <Ionicons name="person-outline" size={18} color="#70788F" />
                <TextInput
                  value={username}
                  onChangeText={(t) => {
                    setUsername(t);
                    if (error) setError("");
                  }}
                  placeholder="Username"
                  placeholderTextColor="rgba(112,120,143,0.6)"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="username"
                  textContentType="username"
                  returnKeyType="next"
                  className="text-navy"
                  style={{ flex: 1, fontSize: 16, paddingVertical: 0 }}
                />
              </View>

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
                  gap: 10,
                }}
              >
                <Ionicons name="key-outline" size={18} color="#70788F" />
                <TextInput
                  value={password}
                  onChangeText={(t) => {
                    setPassword(t);
                    if (error) setError("");
                  }}
                  placeholder="Password"
                  placeholderTextColor="rgba(112,120,143,0.6)"
                  secureTextEntry={!revealed}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="current-password"
                  textContentType="password"
                  returnKeyType="go"
                  onSubmitEditing={() => canSubmit && onSignIn()}
                  className="text-navy"
                  style={{ flex: 1, fontSize: 16, paddingVertical: 0 }}
                />
                <Pressable
                  onPress={() => setRevealed((v) => !v)}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel={revealed ? "Hide password" : "Show password"}
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
              onPress={onSignIn}
              disabled={!canSubmit}
              className="bg-olive"
              style={{
                width: "100%",
                height: 52,
                borderRadius: 14,
                alignItems: "center",
                justifyContent: "center",
                opacity: canSubmit ? 1 : 0.5,
              }}
            >
              <Text style={{ color: "#0B1020", fontSize: 16, fontWeight: "700" }}>
                {busy ? "Signing In…" : "Sign In"}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
