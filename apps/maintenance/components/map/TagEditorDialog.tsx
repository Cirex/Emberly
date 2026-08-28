import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { StaffConfig } from "@/lib/stores/config";
import {
  tagExpiryBadge,
  useTags,
  type ExpiryKind,
  type NewTag,
  type UnitTag,
} from "@/lib/stores/tags";
import { useAccentPalette } from "@/lib/hooks/use-accent";

type ScannerConfig = StaffConfig;

/** Stable empty result — `?? []` inside a zustand selector mints a new array
 *  each snapshot, which reads as "changed" forever (infinite render loop). */
const NO_TAGS: UnitTag[] = [];

/** Property-map tag palette (matches the admin web + Skia tints). */
const PALETTE = [
  "#D1382E",
  "#E38736",
  "#E3B23A",
  "#2E8A5F",
  "#458ADB",
  "#7A6BC7",
  "#5B7C99",
  "#091B54",
];

const EXPIRY: { kind: ExpiryKind; label: string; hint: string }[] = [
  { kind: "never", label: "Never", hint: "Stays until removed" },
  { kind: "duration", label: "After days", hint: "Temporary watch" },
  { kind: "move_out", label: "Until move-out", hint: "Deletes when unit turns vacant" },
  {
    kind: "status_change",
    label: "Until status changes",
    hint: "Watches the current lease status",
  },
];

/**
 * Add / remove the shared tags on one unit. Same edits admins make on the web —
 * they sync to every device on the next tick.
 */
export function TagEditorDialog({
  unitNumber,
  config,
  onClose,
}: {
  unitNumber: string;
  config: ScannerConfig;
  onClose: () => void;
}) {
  const palette = useAccentPalette();
  const dark = useColorScheme().colorScheme === "dark";
  const tags = useTags((s) => s.byUnit[unitNumber] ?? NO_TAGS);
  const addTag = useTags((s) => s.add);
  const removeTag = useTags((s) => s.remove);

  const [label, setLabel] = useState("");
  const [color, setColor] = useState(PALETTE[6]);
  const [kind, setKind] = useState<ExpiryKind>("never");
  const [durationDays, setDurationDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!label.trim() || busy) return;
    setBusy(true);
    setError(null);
    const draft: NewTag = { label: label.trim(), colorHex: color, expiryKind: kind };
    if (kind === "duration") draft.durationDays = Number(durationDays) || 30;
    const created = await addTag(unitNumber, draft, config);
    setBusy(false);
    if (!created) {
      setError("Couldn't add — it may already exist on this unit.");
      return;
    }
    setLabel("");
    setKind("never");
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
        <Pressable
          onPress={() => {}}
          className="bg-white dark:bg-night-surface"
          style={{
            width: "100%",
            maxWidth: 460,
            borderRadius: 22,
            padding: 20,
            gap: 14,
            maxHeight: "88%",
          }}
        >
          <View className="flex-row items-center justify-between">
            <View>
              <Text
                className="text-slate dark:text-white/60"
                style={{
                  fontSize: 11,
                  fontWeight: "700",
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                }}
              >
                Tags
              </Text>
              <Text
                className="text-navy dark:text-white"
                style={{ fontSize: 18, fontWeight: "700" }}
              >
                {unitNumber}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={dark ? "rgba(255,255,255,0.5)" : "#70788F"} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 360 }}>
            {/* existing tags */}
            {tags.length > 0 ? (
              <View className="flex-row flex-wrap" style={{ gap: 7, marginBottom: 14 }}>
                {tags.map((t) => {
                  const badge = tagExpiryBadge(t);
                  return (
                    <View
                      key={t.id}
                      className="flex-row items-center"
                      style={{
                        gap: 6,
                        paddingVertical: 5,
                        paddingLeft: 10,
                        paddingRight: 6,
                        borderRadius: 999,
                        backgroundColor: `${t.colorHex}20`,
                        borderWidth: 1,
                        borderColor: `${t.colorHex}55`,
                      }}
                    >
                      <View
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 4,
                          backgroundColor: t.colorHex,
                        }}
                      />
                      <Text style={{ fontSize: 12.5, fontWeight: "600", color: t.colorHex }}>
                        {t.label}
                      </Text>
                      {badge ? (
                        <Text
                          style={{
                            fontSize: 10,
                            fontWeight: "700",
                            color: t.colorHex,
                            opacity: 0.8,
                          }}
                        >
                          · {badge}
                        </Text>
                      ) : null}
                      <Pressable
                        onPress={() => void removeTag(unitNumber, t.id, config)}
                        hitSlop={8}
                        accessibilityLabel={`Remove ${t.label}`}
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 8,
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: `${t.colorHex}30`,
                        }}
                      >
                        <Ionicons name="close" size={10} color={t.colorHex} />
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text
                className="text-slate dark:text-white/50"
                style={{ fontSize: 12.5, marginBottom: 14 }}
              >
                No tags yet. Anything added here is shared with admins and every device.
              </Text>
            )}

            {/* add form */}
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="New tag (e.g. Aggressive dog)"
              placeholderTextColor={dark ? "rgba(255,255,255,0.35)" : "rgba(112,120,143,0.6)"}
              maxLength={48}
              autoCorrect={false}
              className="text-navy dark:text-white"
              style={{
                fontSize: 15,
                fontWeight: "600",
                borderWidth: 1,
                borderColor: dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.14)",
                borderRadius: 12,
                paddingHorizontal: 13,
                paddingVertical: 10,
              }}
            />

            <View className="flex-row" style={{ gap: 9, marginTop: 12 }}>
              {PALETTE.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setColor(c)}
                  accessibilityLabel={`Color ${c}`}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    backgroundColor: c,
                    borderWidth: color === c ? 2 : 0,
                    borderColor: "#fff",
                    ...(color === c
                      ? {
                          shadowColor: "#091B54",
                          shadowOpacity: 1,
                          shadowRadius: 0,
                          shadowOffset: { width: 0, height: 0 },
                        }
                      : {}),
                  }}
                />
              ))}
            </View>

            <Text
              className="text-slate dark:text-white/60"
              style={{
                fontSize: 11,
                fontWeight: "700",
                textTransform: "uppercase",
                letterSpacing: 0.4,
                marginTop: 14,
                marginBottom: 7,
              }}
            >
              Expires
            </Text>
            <View style={{ gap: 7 }}>
              {EXPIRY.map((o) => {
                const on = kind === o.kind;
                return (
                  <Pressable
                    key={o.kind}
                    onPress={() => setKind(o.kind)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      padding: 11,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: on
                        ? palette.fill
                        : dark
                          ? "rgba(255,255,255,0.16)"
                          : "rgba(9,27,84,0.14)",
                      backgroundColor: on ? `${palette.fill}1F` : "transparent",
                    }}
                  >
                    <View
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 9,
                        borderWidth: 2,
                        borderColor: on ? "#767B24" : dark ? "rgba(255,255,255,0.4)" : "#70788F",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {on ? (
                        <View
                          style={{
                            width: 9,
                            height: 9,
                            borderRadius: 5,
                            backgroundColor: "#767B24",
                          }}
                        />
                      ) : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text
                        className="text-navy dark:text-white"
                        style={{ fontSize: 14, fontWeight: "700" }}
                      >
                        {o.label}
                      </Text>
                      <Text className="text-slate dark:text-white/55" style={{ fontSize: 11.5 }}>
                        {o.hint}
                      </Text>
                    </View>
                    {o.kind === "duration" && on ? (
                      <View className="flex-row items-center" style={{ gap: 5 }}>
                        <TextInput
                          value={durationDays}
                          onChangeText={setDurationDays}
                          keyboardType="number-pad"
                          className="text-navy dark:text-white"
                          style={{
                            width: 46,
                            textAlign: "center",
                            fontWeight: "700",
                            borderWidth: 1,
                            borderColor: dark ? "rgba(255,255,255,0.22)" : "rgba(9,27,84,0.18)",
                            borderRadius: 8,
                            paddingVertical: 5,
                          }}
                        />
                        <Text className="text-slate dark:text-white/55" style={{ fontSize: 12 }}>
                          days
                        </Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>

            {error ? (
              <Text style={{ color: "#D1382E", fontSize: 12, fontWeight: "600", marginTop: 10 }}>
                {error}
              </Text>
            ) : null}
          </ScrollView>

          <Pressable
            onPress={() => void submit()}
            disabled={!label.trim() || busy}
            className="bg-olive"
            style={{
              borderRadius: 14,
              paddingVertical: 13,
              alignItems: "center",
              opacity: !label.trim() || busy ? 0.5 : 1,
            }}
          >
            <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700" }}>
              {busy ? "Adding…" : "Add tag"}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
