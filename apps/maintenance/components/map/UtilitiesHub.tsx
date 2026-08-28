import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { UtilityType } from "@/lib/api/annotations";
import { UTILITY_TYPES } from "@/lib/api/annotations";
import { useAnnotations, type MapAnnotation } from "@/lib/stores/annotations";
import { useSettings } from "@/lib/stores/settings";
import { useUtilityVisibility } from "@/lib/stores/utility-visibility";
import { UTILITY_COLORS, effectiveLineStyle, effectiveLineWeight } from "@/lib/utility-lines";
import { LinePreview } from "@/components/map/UtilityStyleControls";
import { useAccentPalette } from "@/lib/hooks/use-accent";

const NAVY = "#091B54";
const MUTED = "#70788F";
const HAIRLINE = "rgba(9,27,84,0.08)";

/**
 * The utility layer's inventory — the map's runs grouped by type, each row a
 * style preview, name, point count, and a per-device visibility eye (hiding a
 * run never edits the shared annotation). Matches the Color groups sheet so
 * the two map layers are operated the same way. Tapping a row opens the run's
 * inspector; the header chips arm draw mode.
 */
export function UtilitiesHub({
  visible,
  onClose,
  onDrawRun,
  onDropPin,
  onSelectRun,
}: {
  visible: boolean;
  onClose: () => void;
  onDrawRun: () => void;
  onDropPin: () => void;
  onSelectRun: (id: string) => void;
}) {
  const palette = useAccentPalette();
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const ink = dark ? "#FFFFFF" : NAVY;
  const muted = dark ? "rgba(255,255,255,0.5)" : MUTED;
  const hairline = dark ? "rgba(255,255,255,0.10)" : HAIRLINE;
  const quietFill = dark ? "rgba(255,255,255,0.06)" : "rgba(9,27,84,0.05)";
  const insets = useSafeAreaInsets();
  const annotations = useAnnotations((s) => s.annotations);
  const hiddenIds = useUtilityVisibility((s) => s.hiddenIds);
  const toggleHidden = useUtilityVisibility((s) => s.toggle);
  const hiddenTypes = useUtilityVisibility((s) => s.hiddenTypes);
  const toggleType = useUtilityVisibility((s) => s.toggleType);
  const layerVisible = useSettings((s) => s.utilityLayerVisible);
  const setLayerVisible = useSettings((s) => s.setUtilityLayerVisible);

  const runsByType = useMemo(() => {
    const groups = new Map<UtilityType, MapAnnotation[]>();
    for (const a of annotations) {
      if (a.removed || a.kind !== "utility_line" || !a.points || a.points.length < 2) continue;
      const type = a.utilityType ?? "other";
      const list = groups.get(type) ?? [];
      list.push(a);
      groups.set(type, list);
    }
    return groups;
  }, [annotations]);

  const empty = runsByType.size === 0;

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
              {t("utility.title")}
            </Text>
            {/* Master switch: the whole layer on/off (nothing drawn, nothing
                tappable) — the quick declutter the map view needs. */}
            <Pressable
              onPress={() => setLayerVisible(!layerVisible)}
              accessibilityRole="switch"
              accessibilityState={{ checked: layerVisible }}
              accessibilityLabel={t("utility.layerToggle")}
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                alignItems: "center",
                justifyContent: "center",
                marginRight: 6,
                backgroundColor: layerVisible ? `${palette.fill}24` : quietFill,
              }}
            >
              <Ionicons
                name={layerVisible ? "eye-outline" : "eye-off-outline"}
                size={14}
                color={layerVisible ? "#767B24" : muted}
              />
            </Pressable>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t("utility.close")}
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                backgroundColor: dark ? "rgba(255,255,255,0.08)" : "rgba(9,27,84,0.06)",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons
                name="close"
                size={15}
                color={dark ? "rgba(255,255,255,0.72)" : "#4C556F"}
              />
            </Pressable>
          </View>
          <Text
            style={{
              paddingHorizontal: 18,
              paddingBottom: 8,
              fontSize: 11,
              color: muted,
              lineHeight: 15,
            }}
          >
            {t("utility.hubHint")}
          </Text>

          <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 18, paddingBottom: 10 }}>
            {(
              [
                [t("utility.drawRun"), onDrawRun],
                [t("utility.dropPin"), onDropPin],
              ] as const
            ).map(([label, onPress]) => (
              <Pressable
                key={label}
                onPress={onPress}
                accessibilityRole="button"
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  borderRadius: 999,
                  backgroundColor: `${palette.fill}2E`,
                }}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: "700",
                    color: dark ? palette.glassDark : "#5C6018",
                  }}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>

          <ScrollView>
            {empty ? (
              <Text style={{ padding: 18, fontSize: 12.5, color: muted, lineHeight: 18 }}>
                {t("utility.noRuns")}
              </Text>
            ) : (
              UTILITY_TYPES.filter((type) => runsByType.has(type)).map((type) => {
                const layerOff = hiddenTypes.includes(type);
                return (
                  <View key={type}>
                    {/* The layer header IS the switch: colour, name, run count,
                      and an eye for the whole trade. Chasing a water leak, a
                      technician wants everything else out of the way — and
                      hiding is a viewing choice, so nothing leaves the shared
                      map for anybody else. */}
                    <Pressable
                      onPress={() => toggleType(type)}
                      accessibilityRole="switch"
                      accessibilityState={{ checked: !layerOff }}
                      accessibilityLabel={t(`utility.types.${type}`)}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 9,
                        paddingHorizontal: 18,
                        paddingTop: 13,
                        paddingBottom: 6,
                      }}
                    >
                      <View
                        style={{
                          width: 11,
                          height: 11,
                          borderRadius: 3.5,
                          backgroundColor: UTILITY_COLORS[type],
                          opacity: layerOff ? 0.3 : 1,
                        }}
                      />
                      <Text
                        style={{
                          flex: 1,
                          fontSize: 10,
                          fontWeight: "800",
                          letterSpacing: 1,
                          color: muted,
                          opacity: layerOff ? 0.5 : 1,
                        }}
                      >
                        {t(`utility.types.${type}`).toUpperCase()} · {runsByType.get(type)!.length}
                      </Text>
                      <Ionicons
                        name={layerOff ? "eye-off-outline" : "eye-outline"}
                        size={15}
                        color={layerOff ? muted : "#767B24"}
                      />
                    </Pressable>
                    {layerOff
                      ? null
                      : runsByType.get(type)!.map((run) => {
                          const hidden = hiddenIds.includes(run.id);
                          return (
                            <Pressable
                              key={run.id}
                              onPress={() => onSelectRun(run.id)}
                              accessibilityRole="button"
                              style={{
                                flexDirection: "row",
                                alignItems: "center",
                                gap: 10,
                                paddingHorizontal: 18,
                                paddingVertical: 10,
                                borderTopWidth: 1,
                                borderTopColor: hairline,
                                opacity: hidden ? 0.55 : 1,
                              }}
                            >
                              <LinePreview
                                style={effectiveLineStyle(run)}
                                color={UTILITY_COLORS[run.utilityType ?? "other"]}
                                width={30}
                                thickness={
                                  2.5 *
                                  (effectiveLineWeight(run) === "thin"
                                    ? 0.7
                                    : effectiveLineWeight(run) === "thick"
                                      ? 1.5
                                      : 1)
                                }
                              />
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <Text
                                  style={{ fontSize: 13, fontWeight: "700", color: ink }}
                                  numberOfLines={1}
                                >
                                  {run.title.trim() || t("utility.utilityLine")}
                                </Text>
                                <Text style={{ fontSize: 10, color: muted, marginTop: 1 }}>
                                  {t("utility.pointCount", { count: run.points?.length ?? 0 })}
                                  {run.flowArrows ? ` · ${t("utility.flowOn").toLowerCase()}` : ""}
                                  {hidden ? ` · ${t("utility.hiddenBadge")}` : ""}
                                </Text>
                              </View>
                              <Pressable
                                hitSlop={8}
                                onPress={() => toggleHidden(run.id)}
                                accessibilityRole="switch"
                                accessibilityState={{ checked: !hidden }}
                                accessibilityLabel={t("utility.visibility")}
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: 14,
                                  alignItems: "center",
                                  justifyContent: "center",
                                  backgroundColor: hidden ? quietFill : `${palette.fill}24`,
                                }}
                              >
                                <Ionicons
                                  name={hidden ? "eye-off-outline" : "eye-outline"}
                                  size={14}
                                  color={hidden ? muted : "#767B24"}
                                />
                              </Pressable>
                            </Pressable>
                          );
                        })}
                  </View>
                );
              })
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
