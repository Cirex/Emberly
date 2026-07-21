import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { GroupCondition, MapFilterGroup } from "@emberly/core";
import { useMapGroups } from "@/lib/stores/map-groups";

/**
 * The leasing groups sheet — the maintenance app's GroupsSheet ported to the
 * manager, with the editor extended for the new condition kinds the leasing
 * lens runs on: availabilityIn (ResMan UnitStatus), evictionFlag, and
 * balanceBand (presets tiling the heat ramp's bands). Priority = list order;
 * first visible match paints (buildGroupPaint semantics — counts stay live
 * for hidden groups too).
 */

const NAVY = "#091B54";
const MUTED = "#70788F";
const HAIRLINE = "rgba(9,27,84,0.08)";

const PALETTE = ["#E24B4A", "#EF9F27", "#97C459", "#1D9E75", "#378ADD", "#7F77DD", "#D4537E", "#7A1F1F"];
const OCCUPANCY_VALUES = ["Occupied", "Vacant", "Notice to Vacate", "Under Eviction"] as const;
const LEASE_WINDOWS = [30, 60, 90] as const;
/** ResMan UnitStatus values the availabilityIn condition picks from. */
const AVAILABILITY_VALUES = ["Ready", "Not Ready", "Model", "Down"] as const;
/** Balance bands tiling balanceHeatColor's ramp, plus the "over $800" cut. */
const BALANCE_BANDS: { min: number; max: number | null }[] = [
  { min: 0, max: 300 },
  { min: 300, max: 800 },
  { min: 800, max: 1500 },
  { min: 1500, max: null },
  { min: 800, max: null },
];

function conditionOf(group: MapFilterGroup, kind: GroupCondition["kind"]): GroupCondition | undefined {
  return group.conditions.find((c) => c.kind === kind);
}

/** Small pill chip used by the editor's condition pickers. */
function PickChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={on ? { selected: true } : {}}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        backgroundColor: on ? "rgba(162,169,33,0.14)" : "rgba(9,27,84,0.04)",
        borderColor: on ? "rgba(162,169,33,0.55)" : "rgba(9,27,84,0.12)",
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "600", color: on ? "#767B24" : "#4C556F" }}>{label}</Text>
    </Pressable>
  );
}

export function GroupsSheet({
  visible,
  counts,
  onClose,
}: {
  visible: boolean;
  /** group id → live matching-unit count (from buildGroupPaint). */
  counts: Map<string, number>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const store = useMapGroups();
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = editingId ? store.groups.find((g) => g.id === editingId) : undefined;

  const setCondition = (group: MapFilterGroup, kind: GroupCondition["kind"], next: GroupCondition | null) => {
    const rest = group.conditions.filter((c) => c.kind !== kind);
    store.update(group.id, { conditions: next ? [...rest, next] : rest });
  };

  /** Toggle one availability value inside the (single) availabilityIn condition. */
  const toggleAvailability = (group: MapFilterGroup, value: string) => {
    const cur = conditionOf(group, "availabilityIn");
    const values = cur?.kind === "availabilityIn" ? cur.values : [];
    const next = values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
    setCondition(group, "availabilityIn", next.length ? { kind: "availabilityIn", values: next } : null);
  };

  const bandLabel = (band: { min: number; max: number | null }): string => {
    if (band.max === null) return t("map.groups.bandOver", { min: band.min.toLocaleString("en-US") });
    if (band.min === 0) return t("map.groups.bandUpTo", { max: band.max.toLocaleString("en-US") });
    return t("map.groups.bandBetween", {
      min: band.min.toLocaleString("en-US"),
      max: band.max.toLocaleString("en-US"),
    });
  };

  const onNewGroup = () => {
    const created = store.add({
      name: t("map.groups.newGroupName"),
      colorHex: PALETTE[store.groups.length % PALETTE.length],
      conditions: [{ kind: "occupancy", value: "Occupied" }],
      visible: true,
    });
    setEditingId(created.id);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(9,27,84,0.30)", justifyContent: "flex-end" }}>
        <Pressable style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }} onPress={onClose} />
        <View
          style={{
            maxHeight: "82%",
            backgroundColor: "rgba(250,247,240,0.99)",
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingBottom: insets.bottom + 10,
          }}
        >
          <View style={{ alignItems: "center", paddingTop: 8 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: "rgba(9,27,84,0.15)" }} />
          </View>
          <View
            style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingTop: 10, paddingBottom: 4 }}
          >
            <Text style={{ flex: 1, fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: NAVY }}>
              {t("map.groups.title")}
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t("map.groups.close")}
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                backgroundColor: "rgba(9,27,84,0.06)",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="close" size={15} color="#4C556F" />
            </Pressable>
          </View>
          <Text style={{ paddingHorizontal: 18, paddingBottom: 8, fontSize: 11, color: MUTED }}>
            {t("map.groups.priorityHint")}
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
                    borderTopColor: HAIRLINE,
                  }}
                >
                  <View style={{ gap: 2 }}>
                    <Pressable
                      hitSlop={6}
                      disabled={i === 0}
                      onPress={() => store.move(g.id, -1)}
                      accessibilityLabel={t("map.groups.moveUp")}
                    >
                      <Ionicons name="chevron-up" size={13} color={i === 0 ? "rgba(9,27,84,0.15)" : MUTED} />
                    </Pressable>
                    <Pressable
                      hitSlop={6}
                      disabled={i === store.groups.length - 1}
                      onPress={() => store.move(g.id, 1)}
                      accessibilityLabel={t("map.groups.moveDown")}
                    >
                      <Ionicons
                        name="chevron-down"
                        size={13}
                        color={i === store.groups.length - 1 ? "rgba(9,27,84,0.15)" : MUTED}
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
                      borderColor: "rgba(9,27,84,0.2)",
                    }}
                  />
                  <Text style={{ flex: 1, fontSize: 13.5, fontWeight: "700", color: NAVY }} numberOfLines={1}>
                    {g.name}
                  </Text>
                  <Text style={{ fontSize: 12, fontWeight: "800", color: "#4C556F", fontVariant: ["tabular-nums"] }}>
                    {counts.get(g.id) ?? 0}
                  </Text>
                  <Pressable
                    hitSlop={8}
                    onPress={() => store.toggleVisible(g.id)}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: g.visible }}
                    accessibilityLabel={t("map.groups.visibility")}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: g.visible ? "rgba(162,169,33,0.14)" : "rgba(9,27,84,0.05)",
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
                      backgroundColor: "#FFFFFF",
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: "rgba(9,27,84,0.1)",
                      padding: 14,
                      gap: 10,
                    }}
                  >
                    <TextInput
                      value={editing.name}
                      onChangeText={(name) => store.update(g.id, { name })}
                      placeholder={t("map.groups.namePlaceholder")}
                      placeholderTextColor="rgba(112,120,143,0.6)"
                      style={{
                        borderWidth: 1,
                        borderColor: "rgba(9,27,84,0.15)",
                        borderRadius: 10,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        fontSize: 13,
                        fontWeight: "600",
                        color: NAVY,
                        backgroundColor: "#FBF9F1",
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
                            borderColor: NAVY,
                          }}
                        />
                      ))}
                    </View>

                    <Text style={{ fontSize: 9.5, fontWeight: "700", letterSpacing: 1, color: MUTED }}>
                      {t("map.groups.conditionsLabel").toUpperCase()}
                    </Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {OCCUPANCY_VALUES.map((v) => {
                        const cur = conditionOf(editing, "occupancy");
                        const on = cur?.kind === "occupancy" && cur.value === v;
                        return (
                          <PickChip
                            key={v}
                            label={v}
                            on={on}
                            onPress={() => setCondition(editing, "occupancy", on ? null : { kind: "occupancy", value: v })}
                          />
                        );
                      })}
                    </View>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      <PickChip
                        label={t("map.groups.balanceOverZero")}
                        on={Boolean(conditionOf(editing, "balanceOverZero"))}
                        onPress={() =>
                          setCondition(
                            editing,
                            "balanceOverZero",
                            conditionOf(editing, "balanceOverZero") ? null : { kind: "balanceOverZero" },
                          )
                        }
                      />
                      {LEASE_WINDOWS.map((days) => {
                        const cur = conditionOf(editing, "leaseEndsWithin");
                        const on = cur?.kind === "leaseEndsWithin" && cur.days === days;
                        return (
                          <PickChip
                            key={days}
                            label={t("map.groups.leaseEndsWithin", { count: days })}
                            on={on}
                            onPress={() =>
                              setCondition(editing, "leaseEndsWithin", on ? null : { kind: "leaseEndsWithin", days })
                            }
                          />
                        );
                      })}
                      <PickChip
                        label={t("map.groups.evictionFlag")}
                        on={Boolean(conditionOf(editing, "evictionFlag"))}
                        onPress={() =>
                          setCondition(
                            editing,
                            "evictionFlag",
                            conditionOf(editing, "evictionFlag") ? null : { kind: "evictionFlag" },
                          )
                        }
                      />
                    </View>

                    {/* Availability (ResMan UnitStatus) — multi-select values
                        inside one availabilityIn condition. */}
                    <Text style={{ fontSize: 9.5, fontWeight: "700", letterSpacing: 1, color: MUTED }}>
                      {t("map.groups.availabilityLabel").toUpperCase()}
                    </Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {AVAILABILITY_VALUES.map((v) => {
                        const cur = conditionOf(editing, "availabilityIn");
                        const on = cur?.kind === "availabilityIn" && cur.values.includes(v);
                        return <PickChip key={v} label={v} on={on} onPress={() => toggleAvailability(editing, v)} />;
                      })}
                    </View>

                    {/* Balance bands — single-select, tiling the heat ramp. */}
                    <Text style={{ fontSize: 9.5, fontWeight: "700", letterSpacing: 1, color: MUTED }}>
                      {t("map.groups.balanceBandLabel").toUpperCase()}
                    </Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {BALANCE_BANDS.map((band) => {
                        const cur = conditionOf(editing, "balanceBand");
                        const on = cur?.kind === "balanceBand" && cur.min === band.min && cur.max === band.max;
                        return (
                          <PickChip
                            key={`${band.min}-${band.max ?? "inf"}`}
                            label={bandLabel(band)}
                            on={on}
                            onPress={() =>
                              setCondition(editing, "balanceBand", on ? null : { kind: "balanceBand", ...band })
                            }
                          />
                        );
                      })}
                    </View>

                    <View
                      style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}
                    >
                      <Pressable
                        onPress={() => {
                          setEditingId(null);
                          store.remove(g.id);
                        }}
                        accessibilityRole="button"
                      >
                        <Text style={{ fontSize: 12, fontWeight: "700", color: "#D1382E" }}>
                          {t("map.groups.delete")}
                        </Text>
                      </Pressable>
                      <Pressable onPress={() => setEditingId(null)} accessibilityRole="button">
                        <Text style={{ fontSize: 12, fontWeight: "800", color: "#767B24" }}>{t("map.groups.done")}</Text>
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
                backgroundColor: "rgba(162,169,33,0.06)",
              }}
            >
              <Text style={{ fontSize: 12.5, fontWeight: "700", color: "#767B24" }}>{t("map.groups.newGroup")}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
