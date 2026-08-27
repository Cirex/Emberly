import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { GlassSurface } from "@/components/ui/GlassSurface";
import { useAccentPalette } from "@/lib/hooks/use-accent";
import { capture, identify } from "@/lib/analytics";
import { signInWithResman } from "@/lib/api/auth";
import { registerForEmergencyPush } from "@/lib/push";
import { useResManSession } from "@/lib/resman/session";
import { useConfig } from "@/lib/stores/config";

const REVEAL_HIT_WIDTH = 24;

/** Failure reasons with a dedicated translation under signIn.errors.* */
const KNOWN_ERRORS = new Set(["invalid", "rate_limited", "unavailable", "unreachable"]);

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
  const { t } = useTranslation();
  const config = useConfig();
  const palette = useAccentPalette();
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
      setError(
        t(`signIn.errors.${KNOWN_ERRORS.has(result.reason) ? result.reason : "unreachable"}`),
      );
      return;
    }
    await config.signIn({ token: result.token, admin: result.admin });
    // The same credentials, the same moment: establish the technician's OWN
    // ResMan session on this device (native cookie store — never a server),
    // so work-order edits/closes post to ResMan as them. FIRE-AND-FORGET:
    // sign-in must never wait on ResMan's portal (an unresponsive step here
    // once left the spinner sitting at "Signing in…"). The dance runs in the
    // background — Settings shows the result, and a failed establish just
    // means writes wait in the outbox until the tech signs in again. On
    // success the credentials persist in the device Keychain so the session
    // renews itself when ResMan times it out (see lib/resman/session.ts).
    void useResManSession.getState().establish(username.trim(), password, result.resmanSession?.cookies);
    // Tie subsequent events to the staff member by their stable admin id (no
    // name/PII), then record the sign-in with just their role.
    identify(result.admin.adminId, { role: result.admin.role });
    capture("signed_in", { role: result.admin.role });
    // Fire-and-forget: ties this device to the new session for emergency
    // pushes. Idempotent — the tabs layout retries it on mount anyway.
    void registerForEmergencyPush({ baseUrl: config.baseUrl, token: result.token });
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
          {/* Liquid-glass card over the workspace backdrop: shadow lives on an
              unclipped wrapper (GlassSurface clips to its radius), the glass
              itself is the shared primitive so field mode still goes opaque. */}
          <View
            style={{
              width: "100%",
              maxWidth: 500,
              borderRadius: 28,
              shadowColor: "#091B54",
              shadowOpacity: 0.14,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: 8 },
              elevation: 4,
            }}
          >
            <GlassSurface radius={28}>
              <View
                style={{
                  paddingHorizontal: 32,
                  paddingVertical: 40,
                  alignItems: "center",
                  gap: 22,
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
                      onChangeText={(next) => {
                        setUsername(next);
                        if (error) setError("");
                      }}
                      placeholder={t("signIn.username")}
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
                      onChangeText={(next) => {
                        setPassword(next);
                        if (error) setError("");
                      }}
                      placeholder={t("signIn.password")}
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
                      accessibilityLabel={
                        revealed ? t("signIn.hidePassword") : t("signIn.showPassword")
                      }
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
                      style={{
                        color: "#B3261E",
                        fontSize: 13,
                        lineHeight: 18,
                        textAlign: "center",
                      }}
                    >
                      {error}
                    </Text>
                  ) : null}
                </View>

                <GlassSurface radius={16} style={{ width: "100%", opacity: canSubmit ? 1 : 0.55 }}>
                  <Pressable
                    onPress={onSignIn}
                    disabled={!canSubmit}
                    accessibilityRole="button"
                    style={{
                      height: 52,
                      alignItems: "center",
                      justifyContent: "center",
                      // Accent at partial alpha so the blur reads through —
                      // the glass tint, not a solid fill (never hardcoded
                      // olive: the accent theme owns this color).
                      backgroundColor: `${palette.fill}B8`,
                    }}
                  >
                    <Text style={{ color: "#0B1020", fontSize: 16, fontWeight: "700" }}>
                      {busy ? t("signIn.signingIn") : t("signIn.signIn")}
                    </Text>
                  </Pressable>
                </GlassSurface>
              </View>
            </GlassSurface>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
