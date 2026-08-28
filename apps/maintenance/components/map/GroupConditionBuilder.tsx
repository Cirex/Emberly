import { useColorScheme } from "nativewind";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  unitMatchesGroup,
  type GroupCondition,
  type GroupUnit,
  type MapFilterGroup,
} from "@emberly/core";
import {
  CONDITION_KINDS,
  LEASE_WINDOW_PRESETS,
  OCCUPANCY_VALUES,
  buildConditionVocabulary,
  conditionParts,
  defaultConditionFor,
  type ConditionKind,
} from "@/lib/map-group-conditions";
import { useAccentPalette } from "@/lib/hooks/use-accent";

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
  const palette = useAccentPalette();
  const dark = useColorScheme().colorScheme === "dark";
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
        backgroundColor: on
          ? `${palette.fill}24`
          : dark
            ? "rgba(255,255,255,0.06)"
            : "rgba(9,27,84,0.04)",
        borderColor: danger
          ? "rgba(209,56,46,0.4)"
          : on
            ? `${palette.fill}8C`
            : dark
              ? "rgba(255,255,255,0.14)"
              : "rgba(9,27,84,0.12)",
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: "600",
          color: danger ? "#D1382E" : on ? "#767B24" : dark ? "rgba(255,255,255,0.72)" : "#4C556F",
        }}
      >
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
  const dark = useColorScheme().colorScheme === "dark";
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={dark ? "rgba(255,255,255,0.35)" : "rgba(112,120,143,0.6)"}
      keyboardType="number-pad"
      style={{
        minWidth: 74,
        borderWidth: 1,
        borderColor: dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.15)",
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 5,
        fontSize: 12,
        fontWeight: "600",
        color: dark ? "#FFFFFF" : NAVY,
        backgroundColor: dark ? "rgba(255,255,255,0.08)" : "#FBF9F1",
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
  const dark = useColorScheme().colorScheme === "dark";
  const muted = dark ? "rgba(255,255,255,0.5)" : MUTED;
  const [openKind, setOpenKind] = useState<ConditionKind | null>(null);
  const [adding, setAdding] = useState(false);

  const vocab = useMemo(() => buildConditionVocabulary(units), [units]);
  const unusedKinds = CONDITION_KINDS.filter((k) => !group.conditions.some((c) => c.kind === k));
  const matchCount = useMemo(
    () => units.reduce((n, u) => (unitMatchesGroup(u, group, nowMs) ? n + 1 : n), 0),
    [units, group, nowMs],
  );

  /** The per-kind parameter editor, shown under an expanded row. */
  const editorFor = (c: GroupCondition) => {
    switch (c.kind) {
      case "occupancy":
        return (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {OCCUPANCY_VALUES.map((v) => (
              <Chip
                key={v}
                label={v}
                on={c.value === v}
                onPress={() => onSet("occupancy", { kind: "occupancy", value: v })}
              />
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
            <Text style={{ fontSize: 11, color: muted, fontWeight: "700" }}>–</Text>
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
                if (!Number.isNaN(days) && days > 0)
                  onSet("leaseEndsWithin", { kind: "leaseEndsWithin", days });
              }}
            />
          </View>
        );
      // The three data-driven multi-selects share one editor: chips from the
      // synced vocabulary, at least one value kept selected.
      case "availabilityIn":
        return multiSelect(c.kind, c.values, vocab.availabilities);
      case "classificationIn":
        return multiSelect(c.kind, c.values, vocab.classifications);
      case "layoutIn":
        return multiSelect(c.kind, c.values, vocab.layouts);
      // No parameters to edit.
      case "balanceOverZero":
      case "evictionFlag":
        return null;
    }
  };

  function multiSelect(
    kind: "availabilityIn" | "classificationIn" | "layoutIn",
    selected: string[],
    options: string[],
  ) {
    const norm = (s: string) => s.trim().toLowerCase();
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {options.map((v) => {
          const on = selected.some((x) => norm(x) === norm(v));
          return (
            <Chip
              key={v}
              label={v}
              on={on}
              onPress={() => {
                const values = on ? selected.filter((x) => norm(x) !== norm(v)) : [...selected, v];
                // An empty value set matches nothing; keep at least one.
                if (values.length > 0) onSet(kind, { kind, values } as GroupCondition);
              }}
            />
          );
        })}
      </View>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 9.5, fontWeight: "700", letterSpacing: 1, color: muted }}>
        {t("mapGroups.conditionsLabel").toUpperCase()}
      </Text>

      {/* Mockup row anatomy: [Field] OPERATOR [value] · ✕ — tapping the
          field or value chip opens that condition's parameter editor. */}
      {group.conditions.map((c) => {
        const open = openKind === c.kind;
        const hasParams = c.kind !== "balanceOverZero" && c.kind !== "evictionFlag";
        const parts = conditionParts(c);
        const toggle = () => hasParams && setOpenKind(open ? null : c.kind);
        return (
          <View key={c.kind} style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Chip label={t(`mapGroups.fields.${parts.fieldKey}`)} on={open} onPress={toggle} />
              {parts.opKey ? (
                <Text style={{ fontSize: 9, fontWeight: "700", letterSpacing: 0.5, color: muted }}>
                  {t(`mapGroups.ops.${parts.opKey}`).toUpperCase()}
                </Text>
              ) : null}
              {parts.value ? <Chip label={parts.value} on={open} onPress={toggle} /> : null}
              <View style={{ flex: 1 }} />
              <Pressable
                hitSlop={8}
                onPress={() => {
                  if (openKind === c.kind) setOpenKind(null);
                  onSet(c.kind, null);
                }}
                accessibilityRole="button"
                accessibilityLabel={t("mapGroups.removeCondition")}
              >
                <Text style={{ color: "#D1382E", fontSize: 12, fontWeight: "700" }}>✕</Text>
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
                onSet(kind, defaultConditionFor(kind, vocab));
                setAdding(false);
                setOpenKind(kind);
              }}
            />
          ))}
          <Chip danger label={t("mapGroups.cancelAdd")} onPress={() => setAdding(false)} />
        </View>
      ) : unusedKinds.length > 0 ? (
        <Pressable onPress={() => setAdding(true)} accessibilityRole="button">
          <Text style={{ fontSize: 11.5, fontWeight: "700", color: "#767B24" }}>
            {t("mapGroups.addCondition")}
          </Text>
        </Pressable>
      ) : null}

      <Text style={{ fontSize: 11, color: dark ? "rgba(255,255,255,0.72)" : "#4C556F" }}>
        {t("mapGroups.matchCount", { count: matchCount })}
      </Text>
    </View>
  );
}
