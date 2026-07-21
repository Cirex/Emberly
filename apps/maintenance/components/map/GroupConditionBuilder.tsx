import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, TextInput, View } from "react-native";
import { unitMatchesGroup, type GroupCondition, type GroupUnit, type MapFilterGroup } from "@emberly/core";
import {
  CONDITION_KINDS,
  LEASE_WINDOW_PRESETS,
  OCCUPANCY_VALUES,
  conditionSummary,
  defaultConditionFor,
  distinctAvailabilities,
  type ConditionKind,
} from "@/lib/map-group-conditions";

const NAVY = "#091B54";
const MUTED = "#70788F";

/** Small pill chip, shared visual language with the sheet's PickChip. */
function Chip({
  label,
  on,
  danger,
  onPress,
}: {
  label: string;
  on?: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
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
        borderColor: danger ? "rgba(209,56,46,0.4)" : on ? "rgba(162,169,33,0.55)" : "rgba(9,27,84,0.12)",
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "600", color: danger ? "#D1382E" : on ? "#767B24" : "#4C556F" }}>
        {label}
      </Text>
    </Pressable>
  );
}

function NumberField({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (raw: string) => void;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor="rgba(112,120,143,0.6)"
      keyboardType="number-pad"
      style={{
        minWidth: 74,
        borderWidth: 1,
        borderColor: "rgba(9,27,84,0.15)",
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 5,
        fontSize: 12,
        fontWeight: "600",
        color: NAVY,
        backgroundColor: "#FBF9F1",
      }}
    />
  );
}

/**
 * The condition builder (approved Color-groups mockup): one removable row per
 * condition with an inline per-kind editor, "+ Add condition" over the kinds
 * not yet used, and a live "N units match now" readout. One condition per
 * kind — conditions AND together, so duplicates of a kind can never both hold.
 */
export function GroupConditionBuilder({
  group,
  units,
  nowMs,
  onSet,
}: {
  group: MapFilterGroup;
  units: GroupUnit[];
  nowMs: number;
  /** Replace (or with null, remove) the group's condition of this kind. */
  onSet: (kind: ConditionKind, next: GroupCondition | null) => void;
}) {
  const { t } = useTranslation();
  const [openKind, setOpenKind] = useState<ConditionKind | null>(null);
  const [adding, setAdding] = useState(false);

  const availabilities = useMemo(() => distinctAvailabilities(units), [units]);
  const unusedKinds = CONDITION_KINDS.filter((k) => !group.conditions.some((c) => c.kind === k));
  const matchCount = useMemo(
    () => units.reduce((n, u) => (unitMatchesGroup(u, group, nowMs) ? n + 1 : n), 0),
    [units, group, nowMs],
  );

  const summaryText = (c: GroupCondition) => {
    const s = conditionSummary(c);
    return t(`mapGroups.summary.${s.key}`, s.params);
  };

  /** The per-kind parameter editor, shown under an expanded row. */
  const editorFor = (c: GroupCondition) => {
    switch (c.kind) {
      case "occupancy":
        return (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {OCCUPANCY_VALUES.map((v) => (
              <Chip key={v} label={v} on={c.value === v} onPress={() => onSet("occupancy", { kind: "occupancy", value: v })} />
            ))}
          </View>
        );
      case "balanceBand":
        return (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <NumberField
              value={String(c.min)}
              placeholder={t("mapGroups.minPlaceholder")}
              onChange={(raw) => {
                const min = Number.parseInt(raw, 10);
                onSet("balanceBand", { ...c, min: Number.isNaN(min) ? 0 : min });
              }}
            />
            <Text style={{ fontSize: 11, color: MUTED, fontWeight: "700" }}>–</Text>
            <NumberField
              value={c.max === null ? "" : String(c.max)}
              placeholder={t("mapGroups.maxPlaceholder")}
              onChange={(raw) => {
                const max = Number.parseInt(raw, 10);
                onSet("balanceBand", { ...c, max: Number.isNaN(max) ? null : max });
              }}
            />
          </View>
        );
      case "leaseEndsWithin":
        return (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            {LEASE_WINDOW_PRESETS.map((days) => (
              <Chip
                key={days}
                label={t("mapGroups.leaseEndsWithin", { count: days })}
                on={c.days === days}
                onPress={() => onSet("leaseEndsWithin", { kind: "leaseEndsWithin", days })}
              />
            ))}
            <NumberField
              value={LEASE_WINDOW_PRESETS.some((d) => d === c.days) ? "" : String(c.days)}
              placeholder={t("mapGroups.customDays")}
              onChange={(raw) => {
                const days = Number.parseInt(raw, 10);
                if (!Number.isNaN(days) && days > 0) onSet("leaseEndsWithin", { kind: "leaseEndsWithin", days });
              }}
            />
          </View>
        );
      case "availabilityIn":
        return (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {availabilities.map((v) => {
              const on = c.values.some((x) => x.trim().toLowerCase() === v.trim().toLowerCase());
              return (
                <Chip
                  key={v}
                  label={v}
                  on={on}
                  onPress={() => {
                    const values = on
                      ? c.values.filter((x) => x.trim().toLowerCase() !== v.trim().toLowerCase())
                      : [...c.values, v];
                    // An empty value set matches nothing; keep at least one.
                    if (values.length > 0) onSet("availabilityIn", { kind: "availabilityIn", values });
                  }}
                />
              );
            })}
          </View>
        );
      // No parameters to edit.
      case "balanceOverZero":
      case "evictionFlag":
        return null;
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 9.5, fontWeight: "700", letterSpacing: 1, color: MUTED }}>
        {t("mapGroups.conditionsLabel").toUpperCase()}
      </Text>

      {group.conditions.map((c) => {
        const open = openKind === c.kind;
        const hasParams = c.kind !== "balanceOverZero" && c.kind !== "evictionFlag";
        return (
          <View key={c.kind} style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Pressable
                onPress={() => hasParams && setOpenKind(open ? null : c.kind)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                style={{
                  flex: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  borderWidth: 1,
                  borderColor: open ? "rgba(162,169,33,0.55)" : "rgba(9,27,84,0.14)",
                  borderRadius: 10,
                  paddingHorizontal: 10,
                  paddingVertical: 7,
                  backgroundColor: open ? "rgba(162,169,33,0.08)" : "rgba(9,27,84,0.03)",
                }}
              >
                <Text style={{ flex: 1, fontSize: 12, fontWeight: "600", color: NAVY }} numberOfLines={1}>
                  {summaryText(c)}
                </Text>
                {hasParams ? (
                  <Text style={{ fontSize: 10, color: MUTED, fontWeight: "700" }}>{open ? "▴" : "▾"}</Text>
                ) : null}
              </Pressable>
              <Pressable
                hitSlop={8}
                onPress={() => {
                  if (openKind === c.kind) setOpenKind(null);
                  onSet(c.kind, null);
                }}
                accessibilityRole="button"
                accessibilityLabel={t("mapGroups.removeCondition")}
              >
                <Text style={{ color: "#D1382E", fontSize: 13, fontWeight: "700" }}>✕</Text>
              </Pressable>
            </View>
            {open ? editorFor(c) : null}
          </View>
        );
      })}

      {adding ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {unusedKinds.map((kind) => (
            <Chip
              key={kind}
              label={t(`mapGroups.kinds.${kind}`)}
              onPress={() => {
                onSet(kind, defaultConditionFor(kind, availabilities));
                setAdding(false);
                setOpenKind(kind);
              }}
            />
          ))}
          <Chip danger label={t("mapGroups.cancelAdd")} onPress={() => setAdding(false)} />
        </View>
      ) : unusedKinds.length > 0 ? (
        <Pressable onPress={() => setAdding(true)} accessibilityRole="button">
          <Text style={{ fontSize: 11.5, fontWeight: "700", color: "#767B24" }}>{t("mapGroups.addCondition")}</Text>
        </Pressable>
      ) : null}

      <Text style={{ fontSize: 11, color: "#4C556F" }}>
        {t("mapGroups.matchCount", { count: matchCount })}
      </Text>
    </View>
  );
}
