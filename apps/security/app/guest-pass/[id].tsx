import { formatShortDateTime } from "@emberly/core";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { AppStatusBadge } from "@emberly/ui";
import { residentList } from "@/lib/api/guest-passes";
import { PASS_STATUS_META } from "@/lib/guest-pass-display";
import { useConfig } from "@/lib/stores/config";
import { capture } from "@/lib/analytics";
import { useGuestPasses } from "@/lib/stores/guest-passes";

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View className="flex-row items-center justify-between" style={{ paddingVertical: 10, gap: 16 }}>
      <Text className="text-slate dark:text-white/60" style={{ fontSize: 14 }}>{label}</Text>
      <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "600", flexShrink: 1, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

function fmt(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  try {
    return formatShortDateTime(iso);
  } catch {
    return iso;
  }
}

export default function GuestPassDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const config = useConfig();
  const pass = useGuestPasses((s) => s.find(id));
  const revoke = useGuestPasses((s) => s.revoke);
  const [showQR, setShowQR] = useState(false);
  const [revoking, setRevoking] = useState(false);

  if (!pass) {
    return (
      <SafeAreaView className="flex-1 bg-paper-top dark:bg-night-top">
        <View style={{ padding: 24, gap: 12 }}>
          <Text className="text-navy dark:text-white" style={{ fontSize: 20, fontWeight: "700" }}>Pass unavailable</Text>
          <Text className="text-muted">Return to the feed and open the pass again.</Text>
          <Pressable onPress={() => router.back()}><Text className="text-olive-dark" style={{ fontWeight: "700" }}>Close</Text></Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const host = residentList(pass)[0];
  const meta = PASS_STATUS_META[pass.status];

  const onRevoke = () => {
    Alert.alert("Revoke guest pass?", `${pass.guest_name}'s access will be revoked immediately.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revoke",
        style: "destructive",
        onPress: async () => {
          setRevoking(true);
          try {
            await revoke(pass.id, config);
            // No PII: the action only, from the detail screen.
            capture("guest_pass_revoked", { from: "detail" });
            router.back();
          } catch (e) {
            setRevoking(false);
            Alert.alert("Couldn't revoke", e instanceof Error ? e.message : "Please try again.");
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView className="flex-1 bg-paper-top dark:bg-night-top">
      <ScrollView contentContainerStyle={{ padding: 22, gap: 16 }}>
        <View className="flex-row items-start justify-between">
          <View style={{ flex: 1, gap: 8 }}>
            <Text className="text-navy dark:text-white" style={{ fontSize: 26, fontWeight: "700" }}>{pass.guest_name}</Text>
            <AppStatusBadge label={meta.label} tint={meta.tint} />
          </View>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Ionicons name="close" size={26} color="#4C556F" />
          </Pressable>
        </View>

        <AppCardSurface kind="panel">
          <View style={{ paddingHorizontal: 18, paddingVertical: 6 }}>
            <Row label="Host" value={host?.name} />
            <Row label="Unit" value={host?.unit_id ?? undefined} />
            <Row label="Expires" value={fmt(pass.expires_at)} />
            <Row label="Last scan" value={fmt(pass.used_at)} />
            <Row label="Created" value={fmt(pass.created_at)} />
            <Row label="Photos" value={pass.photo_count != null ? String(pass.photo_count) : undefined} />
            <Row label="Email" value={pass.guest_email ?? undefined} />
            <Row label="Phone" value={pass.guest_phone ?? undefined} />
          </View>
        </AppCardSurface>

        {pass.share_url ? (
          <AppCardSurface kind="panel">
            <View style={{ padding: 18, gap: 14, alignItems: "center" }}>
              <Pressable onPress={() => setShowQR((v) => !v)} className="flex-row items-center" style={{ gap: 8, alignSelf: "flex-start" }}>
                <Ionicons name="qr-code-outline" size={20} color="#848F0D" />
                <Text className="text-olive-dark" style={{ fontSize: 15, fontWeight: "700" }}>
                  {showQR ? "Hide QR code" : "Show QR code"}
                </Text>
              </Pressable>
              {showQR ? (
                <View style={{ padding: 16, backgroundColor: "#FFFFFF", borderRadius: 16 }}>
                  <QRCode value={pass.share_url} size={200} />
                </View>
              ) : null}
            </View>
          </AppCardSurface>
        ) : null}

        {pass.status === "active" ? (
          <Pressable
            onPress={onRevoke}
            disabled={revoking}
            style={{ height: 50, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#D1382E", opacity: revoking ? 0.6 : 1 }}
          >
            <Text style={{ color: "#FFFFFF", fontSize: 16, fontWeight: "700" }}>{revoking ? "Revoking…" : "Revoke Pass"}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
