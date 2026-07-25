import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TechBadge } from "@/components/work-orders/rows";
import { useTranslation } from "react-i18next";
import {
  axesOf,
  directionKeys,
  fieldKey,
  optionFor,
  sortFieldsFor,
} from "@/lib/derived/sort-axes";
import { classificationColor } from "@/lib/derived/status";
import { tagIconName } from "@/lib/derived/tags";
import type { FilterSets } from "@/lib/derived/types";
import { useDerivedSnapshot } from "@/lib/hooks/use-derived-snapshot";
import { useShallow } from "zustand/react/shallow";
import { activeFilterCount, useWorkOrdersView } from "@/lib/stores/work-orders-view";
import { HAIRLINE_STRONG, MUTED, NAVY, OLIVE_TEXT } from "@/theme/tokens";

/**
 * The facet filter sheet — port of WorkOrderFilterPanel as a bottom sheet.
 * Self-contained leaf modal: reads the view store + derived snapshot itself
 * (exempt from the screens' no-store-in-components rule) so the host screen
 * only has to render <FilterSheet /> once.
 */


const STATUS_OPTIONS_OPEN = ["Not Started", "Scheduled", "In Progress"];
const STATUS_OPTIONS_CLOSED = ["Completed", "Closed", "Canceled"];
/**
 * Preferred display order. NOT the set of options — the chips are built from
 * whatever the data actually contains, so a classification ResMan adds cannot go
 * missing. This list was hardcoded to three, which silently hid LUX: 162 closed
 * work orders were filterable in the data with no chip to reach them.
 */
const CLASSIFICATION_ORDER = ["Ruby", "Diamond", "Legacy", "LUX"];

/** Every classification present, preferred ones first, then any newcomer. */
function classificationOptions(counts: ReadonlyMap<string, number>): string[] {
  const present = [...counts.keys()].filter((c) => c.trim().length > 0);
  const ranked = (c: string) => {
    const i = CLASSIFICATION_ORDER.findIndex((k) => k.toLowerCase() === c.toLowerCase());
    return i === -1 ? CLASSIFICATION_ORDER.length : i;
  };
  return present.sort((a, b) => ranked(a) - ranked(b) || a.localeCompare(b));
}
const OCCUPANCY_OPTIONS = ["Occupied", "Vacant", "Eviction", "NTV"];

/** Immutable add/remove toggle for one facet array. */
function toggled(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

/**
 * Local 30px capsule chip — AppFilterChip's 36px capsule is taller than the
 * dense sheet wants, so the sheet carries its own compact variant with the
 * same selected/unselected language (olive fill vs translucent white).
 */
function SheetChip({
  label,
  selected,
  count,
  leading,
  onPress,
}: {
  label: string;
  selected: boolean;
  count?: number;
  leading?: React.ReactNode;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        height: 30,
        paddingHorizontal: 11,
        borderRadius: 999,
        backgroundColor: selected ? "rgba(162,169,33,0.85)" : "rgba(255,255,255,0.65)",
        borderWidth: 1,
        borderColor: selected ? "rgba(162,169,33,0.5)" : HAIRLINE_STRONG,
      }}
    >
      {leading}
      <Text style={{ fontSize: 11.3, fontWeight: "600", color: selected ? "#FFFFFF" : NAVY }}>
        {label}
        {count !== undefined && count > 0 ? (
          <Text style={{ color: selected ? "rgba(255,255,255,0.75)" : MUTED, fontWeight: "500" }}>
            {" · "}
            {count}
          </Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

/**
 * iOS-style segmented control for the sort FIELD. One row, equal segments — the
 * shape a single-choice control should have had all along.
 */
function SegmentedRow({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: "rgba(9,27,84,0.055)",
        borderRadius: 12,
        padding: 3,
        gap: 2,
      }}
    >
      {children}
    </View>
  );
}

function Segment({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={selected ? { selected: true } : {}}
      style={{
        flex: 1,
        alignItems: "center",
        paddingVertical: 7,
        paddingHorizontal: 4,
        borderRadius: 9,
        backgroundColor: selected ? "#FFFFFF" : "transparent",
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          fontSize: 11.5,
          fontWeight: "700",
          color: selected ? NAVY : MUTED,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Direction, labelled in the field's own language — Newest/Oldest for a date,
 * Low → High for an id. Never "Ascending", which a technician has to decode.
 */
function DirectionButton({
  label,
  arrow,
  selected,
  onPress,
}: {
  label: string;
  arrow: "arrow-up" | "arrow-down";
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={selected ? { selected: true } : {}}
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingVertical: 9,
        borderRadius: 11,
        backgroundColor: selected ? "rgba(162,169,33,0.9)" : "rgba(9,27,84,0.055)",
      }}
    >
      <Ionicons name={arrow} size={13} color={selected ? "#FFFFFF" : MUTED} />
      <Text
        numberOfLines={1}
        style={{ fontSize: 12, fontWeight: "700", color: selected ? "#FFFFFF" : MUTED }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <Text
      style={{
        fontSize: 10.5,
        fontWeight: "700",
        letterSpacing: 0.8,
        color: MUTED,
        marginTop: 16,
        marginBottom: 8,
      }}
    >
      {text.toUpperCase()}
    </Text>
  );
}

function ChipWrapRow({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{children}</View>;
}

export function FilterSheet() {
  const insets = useSafeAreaInsets();
  const view = useWorkOrdersView(
    useShallow((s) => ({
      displayMode: s.displayMode,
      sortOption: s.sortOption,
      signalFilter: s.signalFilter,
      openFilters: s.openFilters,
      closedFilters: s.closedFilters,
      filterSheetOpen: s.filterSheetOpen,
      clearFilters: s.clearFilters,
      setFilters: s.setFilters,
      setSignalFilter: s.setSignalFilter,
      setSortOption: s.setSortOption,
      setFilterSheetOpen: s.setFilterSheetOpen,
    })),
  );
  const snapshot = useDerivedSnapshot();

  const modeKey: "open" | "closed" = view.displayMode === "closed" ? "closed" : "open";
  const { t } = useTranslation();
  // The stored option decomposed for the two controls below.
  const activeAxes = axesOf(view.sortOption);
  const filters = modeKey === "closed" ? view.closedFilters : view.openFilters;
  const activeCount = activeFilterCount(view);
  const panel = snapshot.panel;

  const close = () => view.setFilterSheetOpen(false);
  const toggle = (facet: keyof FilterSets, value: string) =>
    view.setFilters(modeKey, { ...filters, [facet]: toggled(filters[facet], value) });

  const statusOptions = modeKey === "closed" ? STATUS_OPTIONS_CLOSED : STATUS_OPTIONS_OPEN;
  // Already search/mode-gated and in the curated triage order.
  const tagOptions = panel.tagOptions;

  return (
    <Modal
      visible={view.filterSheetOpen}
      transparent
      animationType="slide"
      onRequestClose={close}
    >
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          onPress={close}
          accessibilityLabel="Close filters"
          style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(9,27,84,0.30)" }]}
        />
        <View
          style={{
            maxHeight: "78%",
            borderTopLeftRadius: 26,
            borderTopRightRadius: 26,
            overflow: "hidden",
            borderWidth: 1,
            borderColor: HAIRLINE_STRONG,
          }}
        >
          {/* Liquid glass sheet: blur over the dimmed workspace, warm-paper wash on top. */}
          <BlurView intensity={44} tint="light" style={{ backgroundColor: "rgba(252,250,244,0.72)" }}>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }}>
            {/* Header ------------------------------------------------------ */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
              <Ionicons name="funnel-outline" size={15} color={NAVY} />
              <Text style={{ fontSize: 15, fontWeight: "700", color: NAVY }}>Filters</Text>
              {activeCount > 0 ? (
                <View
                  style={{
                    backgroundColor: "rgba(162,169,33,0.18)",
                    borderRadius: 999,
                    paddingHorizontal: 8,
                    paddingVertical: 2.5,
                  }}
                >
                  <Text style={{ fontSize: 10.5, fontWeight: "700", color: OLIVE_TEXT }}>
                    {activeCount} active
                  </Text>
                </View>
              ) : null}
              <View style={{ flex: 1 }} />
              {activeCount > 0 ? (
                <Pressable onPress={view.clearFilters} hitSlop={8} accessibilityRole="button">
                  <Text style={{ fontSize: 12, fontWeight: "600", color: OLIVE_TEXT }}>Clear</Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={close}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={8}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  backgroundColor: "rgba(9,27,84,0.07)",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name="close" size={15} color={NAVY} />
              </Pressable>
            </View>

            {/* Sort by ------------------------------------------------------
                Two axes, not twelve pills. The flat list wrapped to four rows
                for a single choice, and three of the fields had only one
                direction available at all. `modeKey` folds every other board
                mode onto "open" for the field list. */}
            <SectionLabel text={t("workOrders.sort.title")} />
            <SegmentedRow>
              {sortFieldsFor(modeKey).map((field) => (
                <Segment
                  key={field}
                  label={t(`workOrders.sort.field.${fieldKey(field)}`)}
                  selected={activeAxes.field === field}
                  onPress={() => view.setSortOption(optionFor(field, activeAxes.direction))}
                />
              ))}
            </SegmentedRow>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 9 }}>
              {(["desc", "asc"] as const).map((direction) => (
                <DirectionButton
                  key={direction}
                  label={t(
                    `workOrders.sort.direction.${directionKeys(activeAxes.field)[direction]}`,
                  )}
                  arrow={direction === "desc" ? "arrow-down" : "arrow-up"}
                  selected={activeAxes.direction === direction}
                  onPress={() => view.setSortOption(optionFor(activeAxes.field, direction))}
                />
              ))}
            </View>

            {/* Signals (open mode) — single-select; tapping the active one
                clears back to "all". Lived in the control bar until rev 6. */}
            {modeKey === "open" ? (
              <>
                <SectionLabel text="Signals" />
                <ChipWrapRow>
                  {(
                    [
                      { id: "callbacks", label: "Callbacks", icon: "arrow-u-left-top" },
                      { id: "duplicates", label: "Duplicates", icon: "content-duplicate" },
                    ] as const
                  ).map((s) => {
                    const selected = view.signalFilter === s.id;
                    return (
                      <SheetChip
                        key={s.id}
                        label={s.label}
                        count={selected ? panel.signalWorkOrderCount : undefined}
                        selected={selected}
                        onPress={() => view.setSignalFilter(selected ? "all" : s.id)}
                        leading={
                          <MaterialCommunityIcons
                            name={s.icon}
                            size={11}
                            color={selected ? "#FFFFFF" : MUTED}
                          />
                        }
                      />
                    );
                  })}
                </ChipWrapRow>
              </>
            ) : null}

            {/* Status ------------------------------------------------------- */}
            <SectionLabel text="Status" />
            <ChipWrapRow>
              {statusOptions.map((status) => (
                <SheetChip
                  key={status}
                  label={status}
                  count={panel.statusCounts.get(status)}
                  selected={filters.status.includes(status)}
                  onPress={() => toggle("status", status)}
                />
              ))}
            </ChipWrapRow>

            {/* Classification ----------------------------------------------- */}
            <SectionLabel text="Classification" />
            <ChipWrapRow>
              {classificationOptions(panel.classificationCounts).map((classification) => (
                <SheetChip
                  key={classification}
                  label={classification}
                  count={panel.classificationCounts.get(classification)}
                  selected={filters.classification.includes(classification)}
                  onPress={() => toggle("classification", classification)}
                  leading={
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: classificationColor(classification),
                      }}
                    />
                  }
                />
              ))}
            </ChipWrapRow>

            {/* Occupancy ---------------------------------------------------- */}
            <SectionLabel text="Occupancy" />
            <ChipWrapRow>
              {OCCUPANCY_OPTIONS.map((occupancy) => (
                <SheetChip
                  key={occupancy}
                  label={occupancy}
                  count={panel.occupancyCounts.get(occupancy)}
                  selected={filters.occupancy.includes(occupancy)}
                  onPress={() => toggle("occupancy", occupancy)}
                />
              ))}
            </ChipWrapRow>

            {/* Technician --------------------------------------------------- */}
            <SectionLabel text="Technician" />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {panel.technicianOptions.map((name) => {
                const count = panel.technicianCounts.get(name);
                const selected = filters.technician.includes(name);
                const disabled = !selected && !count;
                return (
                  <Pressable
                    key={name}
                    disabled={disabled}
                    onPress={() => toggle("technician", name)}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled }}
                    style={{
                      flexBasis: "48%",
                      flexGrow: 1,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 7,
                      paddingHorizontal: 9,
                      paddingVertical: 7,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: selected ? "rgba(162,169,33,0.5)" : HAIRLINE_STRONG,
                      backgroundColor: selected ? "rgba(162,169,33,0.10)" : "rgba(255,255,255,0.65)",
                      opacity: disabled ? 0.4 : 1,
                    }}
                  >
                    <TechBadge name={name} size={22} />
                    <Text
                      numberOfLines={1}
                      style={{ flex: 1, fontSize: 11, fontWeight: "600", color: NAVY }}
                    >
                      {name}
                    </Text>
                    {count ? (
                      <Text style={{ fontSize: 10.5, color: MUTED, fontVariant: ["tabular-nums"] }}>
                        {count}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>

            {/* Tags --------------------------------------------------------- */}
            {tagOptions.length > 0 ? (
              <>
                <SectionLabel text="Tags" />
                <ChipWrapRow>
                  {tagOptions.map((tag) => {
                    const selected = filters.tags.includes(tag);
                    return (
                      <SheetChip
                        key={tag}
                        label={tag}
                        count={panel.tagCounts.get(tag)}
                        selected={selected}
                        onPress={() => toggle("tags", tag)}
                        leading={
                          <MaterialCommunityIcons
                            name={tagIconName(tag, selected) as never}
                            size={11}
                            color={selected ? "#FFFFFF" : MUTED}
                          />
                        }
                      />
                    );
                  })}
                </ChipWrapRow>
              </>
            ) : null}
          </ScrollView>
          </BlurView>
        </View>
      </View>
    </Modal>
  );
}
