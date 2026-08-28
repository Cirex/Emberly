import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { GroupCondition, GroupUnit, MapFilterGroup } from "@emberly/core";
import { GroupConditionBuilder } from "@/components/map/GroupConditionBuilder";
import { conditionSummary } from "@/lib/map-group-conditions";
import { useMapGroups } from "@/lib/stores/map-groups";
import { useAccentPalette } from "@/lib/hooks/use-accent";

const NAVY = "#091B54";
const MUTED = "#70788F";
const HAIRLINE = "rgba(9,27,84,0.08)";

const PALETTE = [
  "#E24B4A",
  "#EF9F27",
  "#97C459",
  "#1D9E75",
  "#378ADD",
  "#7F77DD",
  "#D4537E",
  "#888780",
];

/**
 * The Color groups sheet (approved mockup): list of groups — swatch, name,
 * live count, visibility eye, priority reorder — plus an inline editor for
 * the tapped group. Priority = list order; first visible match paints.
 */
export function GroupsSheet({
  visible,
  counts,
  units,
  onClose,
}: {
  visible: boolean;
  /** group id → live matching-unit count (from buildGroupPaint). */
  counts: Map<string, number>;
  /** The synced units — the condition builder's vocabulary and live counts. */
  units: GroupUnit[];
  onClose: () => void;
}) {
  const palette = useAccentPalette();
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const ink = dark ? "#FFFFFF" : NAVY;
  const muted = dark ? "rgba(255,255,255,0.5)" : MUTED;
  const slate = dark ? "rgba(255,255,255,0.72)" : "#4C556F";
  const hairline = dark ? "rgba(255,255,255,0.10)" : HAIRLINE;
  const quietFill = dark ? "rgba(255,255,255,0.06)" : "rgba(9,27,84,0.05)";
  const insets = useSafeAreaInsets();
  const store = useMapGroups();
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = editingId ? store.groups.find((g) => g.id === editingId) : undefined;
  // Frozen per open — the live match count shouldn't drift mid-edit.
  const nowMs = useMemo(() => Date.now(), [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const setCondition = (
    group: MapFilterGroup,
    kind: GroupCondition["kind"],
    next: GroupCondition | null,
  ) => {
    const rest = group.conditions.filter((c) => c.kind !== kind);
    store.update(group.id, { conditions: next ? [...rest, next] : rest });
  };

  const onNewGroup = () => {
    const created = store.add({
      name: t("mapGroups.newGroupName"),
      colorHex: PALETTE[store.groups.length % PALETTE.length],
      conditions: [{ kind: "occupancy", value: "Occupied" }],
      visible: true,
    });
    setEditingId(created.id);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(9,27,84,0.30)", justifyContent: "flex-end" }}>
        <Pressable
          style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
          onPress={onClose}
        />
        <View
          style={{
            maxHeight: "82%",
            backgroundColor: dark ? "#1C2129" : "rgba(250,247,240,0.99)",
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingBottom: insets.bottom + 10,
          }}
        >
          <View style={{ alignItems: "center", paddingTop: 8 }}>
            <View
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.15)",
              }}
            />
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 18,
              paddingTop: 10,
              paddingBottom: 4,
            }}
          >
            <Text
              style={{ flex: 1, fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: ink }}
            >
              {t("mapGroups.title")}
            </Text>
            {/* Master switch: paint the map by groups, or leave it plain. */}
            <Pressable
              onPress={() => store.setEnabled(!store.enabled)}
              accessibilityRole="switch"
              accessibilityState={{ checked: store.enabled }}
              accessibilityLabel={t("mapGroups.paintToggle")}
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                alignItems: "center",
                justifyContent: "center",
                marginRight: 6,
                backgroundColor: store.enabled ? `${palette.fill}24` : quietFill,
              }}
            >
              <Ionicons
                name={store.enabled ? "eye-outline" : "eye-off-outline"}
                size={14}
                color={store.enabled ? "#767B24" : muted}
              />
            </Pressable>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t("mapGroups.close")}
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                backgroundColor: dark ? "rgba(255,255,255,0.08)" : "rgba(9,27,84,0.06)",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="close" size={15} color={slate} />
            </Pressable>
          </View>
          <Text style={{ paddingHorizontal: 18, paddingBottom: 8, fontSize: 11, color: muted }}>
            {t("mapGroups.priorityHint")}
          </Text>

          <ScrollView>
            {store.groups.map((g, i) => (
              <View key={g.id}>
                <Pressable
                  onPress={() => setEditingId((prev) => (prev === g.id ? null : g.id))}
                  accessibilityRole="button"
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 18,
                    paddingVertical: 11,
                    borderTopWidth: 1,
                    borderTopColor: hairline,
                  }}
                >
                  <View style={{ gap: 2 }}>
                    <Pressable
                      hitSlop={6}
                      disabled={i === 0}
                      onPress={() => store.move(g.id, -1)}
                      accessibilityLabel={t("mapGroups.moveUp")}
                    >
                      <Ionicons
                        name="chevron-up"
                        size={13}
                        color={
                          i === 0 ? (dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.15)") : muted
                        }
                      />
                    </Pressable>
                    <Pressable
                      hitSlop={6}
                      disabled={i === store.groups.length - 1}
                      onPress={() => store.move(g.id, 1)}
                      accessibilityLabel={t("mapGroups.moveDown")}
                    >
                      <Ionicons
                        name="chevron-down"
                        size={13}
                        color={
                          i === store.groups.length - 1
                            ? dark
                              ? "rgba(255,255,255,0.18)"
                              : "rgba(9,27,84,0.15)"
                            : muted
                        }
                      />
                    </Pressable>
                  </View>
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 7,
                      backgroundColor: g.colorHex,
                      borderWidth: 1,
                      borderColor: dark ? "rgba(255,255,255,0.25)" : "rgba(9,27,84,0.2)",
                    }}
                  />
                  <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <Text
                      style={{ fontSize: 13.5, fontWeight: "700", color: ink }}
                      numberOfLines={1}
                    >
                      {g.name}
                    </Text>
                    {g.conditions.length > 0 ? (
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                        {g.conditions.map((c) => {
                          const s = conditionSummary(c);
                          return (
                            <Text
                              key={c.kind}
                              style={{
                                fontSize: 9.5,
                                fontWeight: "600",
                                color: slate,
                                backgroundColor: quietFill,
                                borderWidth: 1,
                                borderColor: dark ? "rgba(255,255,255,0.14)" : "rgba(9,27,84,0.12)",
                                borderRadius: 999,
                                paddingHorizontal: 7,
                                paddingVertical: 2,
                                overflow: "hidden",
                              }}
                            >
                              {t(`mapGroups.summary.${s.key}`, s.params)}
                            </Text>
                          );
                        })}
                      </View>
                    ) : null}
                  </View>
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: "800",
                      color: slate,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {counts.get(g.id) ?? 0}
                  </Text>
                  <Pressable
                    hitSlop={8}
                    onPress={() => store.toggleVisible(g.id)}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: g.visible }}
                    accessibilityLabel={t("mapGroups.visibility")}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: g.visible ? `${palette.fill}24` : quietFill,
                    }}
                  >
                    <Ionicons
                      name={g.visible ? "eye-outline" : "eye-off-outline"}
                      size={14}
                      color={g.visible ? "#767B24" : MUTED}
                    />
                  </Pressable>
                </Pressable>

                {editing && editing.id === g.id ? (
                  <View
                    style={{
                      marginHorizontal: 12,
                      marginBottom: 12,
                      backgroundColor: dark ? "rgba(255,255,255,0.06)" : "#FFFFFF",
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: dark ? "rgba(255,255,255,0.12)" : "rgba(9,27,84,0.1)",
                      padding: 14,
                      gap: 10,
                    }}
                  >
                    <TextInput
                      value={editing.name}
                      onChangeText={(name) => store.update(g.id, { name })}
                      placeholder={t("mapGroups.namePlaceholder")}
                      placeholderTextColor={
                        dark ? "rgba(255,255,255,0.35)" : "rgba(112,120,143,0.6)"
                      }
                      style={{
                        borderWidth: 1,
                        borderColor: dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.15)",
                        borderRadius: 10,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        fontSize: 13,
                        fontWeight: "600",
                        color: ink,
                        backgroundColor: dark ? "rgba(255,255,255,0.08)" : "#FBF9F1",
                      }}
                    />
                    <View style={{ flexDirection: "row", gap: 7 }}>
                      {PALETTE.map((hex) => (
                        <Pressable
                          key={hex}
                          onPress={() => store.update(g.id, { colorHex: hex })}
                          accessibilityRole="button"
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 8,
                            backgroundColor: hex,
                            borderWidth: editing.colorHex === hex ? 2.5 : 0,
                            borderColor: dark ? "#FFFFFF" : NAVY,
                          }}
                        />
                      ))}
                    </View>

                    <GroupConditionBuilder
                      group={editing}
                      units={units}
                      nowMs={nowMs}
                      onSet={(kind, next) => setCondition(editing, kind, next)}
                    />

                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginTop: 2,
                      }}
                    >
                      <Pressable
                        onPress={() => {
                          setEditingId(null);
                          store.remove(g.id);
                        }}
                        accessibilityRole="button"
                      >
                        <Text style={{ fontSize: 12, fontWeight: "700", color: "#D1382E" }}>
                          {t("mapGroups.delete")}
                        </Text>
                      </Pressable>
                      <Pressable onPress={() => setEditingId(null)} accessibilityRole="button">
                        <Text style={{ fontSize: 12, fontWeight: "800", color: "#767B24" }}>
                          {t("mapGroups.done")}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </View>
            ))}

            <Pressable
              onPress={onNewGroup}
              accessibilityRole="button"
              style={{
                margin: 14,
                borderWidth: 1.5,
                borderStyle: "dashed",
                borderColor: "rgba(118,123,36,0.5)",
                borderRadius: 12,
                paddingVertical: 10,
                alignItems: "center",
                backgroundColor: `${palette.fill}0F`,
              }}
            >
              <Text style={{ fontSize: 12.5, fontWeight: "700", color: "#767B24" }}>
                {t("mapGroups.newGroup")}
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
