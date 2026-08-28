import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { ClassificationChip, StatusText } from "@/components/work-orders/rows";
import {
  MAKE_READY_STAGES,
  type MakeReadyGroup,
  type MakeReadyQuickFilter,
  type MakeReadyStage,
  type MoveInUrgency,
  currentStageOf,
  isStageCompleted,
  quickFilterIncludes,
  unitIsReady,
  urgencyShowsBadge,
} from "@/lib/derived/make-ready";
import { TINT } from "@/lib/derived/status";
import type { ParsedWorkOrder } from "@/lib/derived/types";
import { abbreviatedDate, calendarDaysBetween } from "@/lib/derived/time";
import { HAIRLINE, HAIRLINE_SOFT, MUTED } from "@/theme/tokens";
import { useAccentPalette } from "@/lib/hooks/use-accent";

/**
 * Make Ready turns board. Phone shows the turn rows banded by whether a
 * move-in is scheduled, each row carrying a move-in chip and the six-segment
 * labeled stage bar; tablet keeps the frozen-column board — a pinned unit
 * column beside a horizontally scrolling stage grid, kept in sync by fixed
 * cell heights.
 */

const HEADER_HEIGHT = 38;
const CELL_HEIGHT = 78;
const STAGE_COUNT = MAKE_READY_STAGES.length;

const FILTER_ORDER: MakeReadyQuickFilter[] = [
  "all",
  "atRisk",
  "dueThisWeek",
  "incomplete",
  "noMoveInDate",
];

const RED = "#D1382E";
const GREEN = "#33A666";
const AMBER = "#B05E14";
const SCHEDULED_BAND_LABEL = "#A32D2D";

const URGENCY_BADGE_COLOR: Partial<Record<MoveInUrgency, string>> = {
  overdue: RED,
  today: "#EB852E",
  nextSevenDays: "#E38736",
};

// ── Quick-filter chip row ───────────────────────────────────────────────────

/** Option 2 capsule: thin outline at rest, solid navy when selected. */
function FilterChip({
  label,
  count,
  selected,
  onPress,
}: {
  label: string;
  count: number;
  selected: boolean;
  onPress: () => void;
}) {
  const dark = useColorScheme().colorScheme === "dark";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 12,
        height: 34,
        borderRadius: 999,
        backgroundColor: selected
          ? dark
            ? "rgba(255,255,255,0.92)"
            : "rgba(9,27,84,0.9)"
          : "transparent",
        borderWidth: 1,
        borderColor: selected
          ? "transparent"
          : dark
            ? "rgba(255,255,255,0.18)"
            : "rgba(9,27,84,0.16)",
      }}
    >
      <Text
        style={{
          fontSize: 12,
          fontWeight: "600",
          color: selected
            ? dark
              ? "#14181F"
              : "#FFFFFF"
            : dark
              ? "rgba(255,255,255,0.72)"
              : "#4C556F",
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontSize: 11,
          fontWeight: "700",
          fontVariant: ["tabular-nums"],
          color: selected
            ? dark
              ? "rgba(20,24,31,0.75)"
              : "rgba(255,255,255,0.75)"
            : dark
              ? "rgba(255,255,255,0.5)"
              : MUTED,
        }}
      >
        {count}
      </Text>
    </Pressable>
  );
}

function EyeChip({
  showCompleted,
  showLabel,
  onPress,
}: {
  showCompleted: boolean;
  showLabel: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const chipInk = dark ? "rgba(255,255,255,0.72)" : "#4C556F";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: showCompleted }}
      accessibilityLabel={
        showCompleted ? t("makeReady.hideCompleted") : t("makeReady.showCompleted")
      }
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 11,
        height: 34,
        borderRadius: 999,
        backgroundColor: dark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.5)",
        borderWidth: 1,
        borderColor: dark ? "rgba(255,255,255,0.12)" : "rgba(9,27,84,0.12)",
      }}
    >
      <Ionicons
        name={showCompleted ? "eye-outline" : "eye-off-outline"}
        size={13}
        color={chipInk}
      />
      {showLabel ? (
        <Text style={{ fontSize: 12, fontWeight: "600", color: chipInk }}>
          {showCompleted ? t("makeReady.hideCompleted") : t("makeReady.showCompleted")}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────

function UrgencyBadge({ urgency }: { urgency: MoveInUrgency }) {
  const { t } = useTranslation();
  const color = URGENCY_BADGE_COLOR[urgency];
  if (!color) return null;
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 1.5,
        borderRadius: 999,
        backgroundColor: `${color}24`, // 14% alpha
      }}
    >
      <Text style={{ fontSize: 8.5, fontWeight: "700", letterSpacing: 0.4, color }}>
        {t(`makeReady.urgency.${urgency}`).toUpperCase()}
      </Text>
    </View>
  );
}

/** Six flex capsules — one per stage, filled olive up to completedStageCount
 *  (the tablet board's compact strip). */
function ProgressStrip({ completed }: { completed: number }) {
  const palette = useAccentPalette();
  const dark = useColorScheme().colorScheme === "dark";
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {MAKE_READY_STAGES.map((stage, i) => (
        <View
          key={stage}
          style={{
            flex: 1,
            height: 6,
            borderRadius: 3,
            backgroundColor:
              i < completed ? palette.fill : dark ? "rgba(255,255,255,0.10)" : "rgba(9,27,84,0.10)",
          }}
        />
      ))}
    </View>
  );
}

/** The six-segment stage bar with 7.5px labels: green when the stage is done,
 *  olive for the stage the turn is currently on, faint for the rest. */
function StageBar({ group }: { group: MakeReadyGroup }) {
  const palette = useAccentPalette();
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const current = currentStageOf(group);
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {MAKE_READY_STAGES.map((stage) => {
        const done = isStageCompleted(group.stages[stage]);
        const isCurrent = stage === current;
        return (
          <View key={stage} style={{ flex: 1, gap: 3 }}>
            <View
              style={{
                height: 6,
                borderRadius: 3,
                backgroundColor: done
                  ? GREEN
                  : isCurrent
                    ? palette.fill
                    : dark
                      ? "rgba(255,255,255,0.08)"
                      : "rgba(9,27,84,0.08)",
              }}
            />
            <Text
              numberOfLines={1}
              style={{
                fontSize: 7.5,
                fontWeight: "700",
                color: done ? GREEN : isCurrent ? palette.text : "#98A0B4",
              }}
            >
              {t(`makeReady.stagesShort.${stage}`)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// Each stage gets its own tint so the board reads at a glance.
const STAGE_TINT: Record<MakeReadyStage, string> = {
  trashOut: "#70788F",
  punch: "#848F0D",
  flooring: "#2563B4",
  finalInspection: "#5B4BA8",
  cleaning: "#2C8C7A",
  rekey: "#C79433",
};

/** The lead chip: the stage this turn is currently on, tinted per stage. */
function StageChip({ stage }: { stage: MakeReadyStage }) {
  const { t } = useTranslation();
  const color = STAGE_TINT[stage];
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: `${color}18`,
        borderWidth: 1,
        borderColor: `${color}55`,
      }}
    >
      <Text style={{ fontSize: 10, fontWeight: "700", color }}>
        {t(`makeReady.stages.${stage}`)}
      </Text>
    </View>
  );
}

/** The move-in chip: red-filled "Nd late" past date, amber inside 7 days,
 *  olive dated chip beyond that, nothing when no move-in is set. */
function MoveInChip({ moveInAt, nowMs }: { moveInAt: number | null; nowMs: number }) {
  const palette = useAccentPalette();
  const { t } = useTranslation();
  if (moveInAt === null) return null;
  const days = calendarDaysBetween(nowMs, moveInAt);
  if (days < 0) {
    return (
      <View
        style={{
          paddingHorizontal: 8,
          paddingVertical: 2.5,
          borderRadius: 999,
          backgroundColor: RED,
        }}
      >
        <Text style={{ fontSize: 9.5, fontWeight: "800", color: "#FFFFFF" }}>
          {t("makeReady.chip.late", { count: -days })}
        </Text>
      </View>
    );
  }
  const soon = days <= 7;
  const color = soon ? AMBER : palette.text;
  const label =
    days === 0
      ? t("makeReady.chip.moveInToday")
      : soon
        ? t("makeReady.chip.moveInSoon", { count: days })
        : t("makeReady.chip.moveInDate", { date: abbreviatedDate(moveInAt, nowMs) });
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2.5,
        borderRadius: 999,
        backgroundColor: `${color}14`,
        borderWidth: 1,
        borderColor: `${color}42`,
      }}
    >
      <Text style={{ fontSize: 9.5, fontWeight: "700", color, fontVariant: ["tabular-nums"] }}>
        {label}
      </Text>
    </View>
  );
}

/** Expanded row: the six stages as a labeled circle strip (olive check when
 *  done, empty ring when not) — the mockup's glyph row, no bordered cells. */
function StageGlyphStrip({ group }: { group: MakeReadyGroup }) {
  const dark = useColorScheme().colorScheme === "dark";
  const palette = useAccentPalette();
  const { t } = useTranslation();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 2 }}>
      {MAKE_READY_STAGES.map((stage) => {
        const done = isStageCompleted(group.stages[stage]);
        return (
          <View key={stage} style={{ alignItems: "center", gap: 4, width: 52 }}>
            <View
              style={{
                width: 30,
                height: 30,
                borderRadius: 15,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: done
                  ? `${palette.fill}2E`
                  : dark
                    ? "rgba(255,255,255,0.06)"
                    : "rgba(9,27,84,0.06)",
              }}
            >
              {done ? (
                <Ionicons name="checkmark" size={15} color={palette.text} />
              ) : (
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    borderWidth: 1.5,
                    borderColor: "#98A0B4",
                  }}
                />
              )}
            </View>
            <Text
              numberOfLines={1}
              style={{ fontSize: 8.5, fontWeight: "700", color: done ? palette.text : "#98A0B4" }}
            >
              {t(`makeReady.stagesShort.${stage}`)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** Stage value line: Done / status / em-dash, with the technician beneath. */
function StageValue({ wo }: { wo: ParsedWorkOrder | null }) {
  const done = isStageCompleted(wo);
  return (
    <>
      {wo === null ? (
        <Text
          className="text-muted dark:text-white/50"
          style={{ fontSize: 10.5, fontWeight: "600" }}
        >
          —
        </Text>
      ) : done ? (
        <Text style={{ fontSize: 10.5, fontWeight: "700", color: TINT.ready }}>Done</Text>
      ) : (
        <StatusText status={wo.status} />
      )}
      {wo !== null ? (
        <Text
          className="text-muted dark:text-white/50"
          numberOfLines={1}
          style={{ fontSize: 9, marginTop: 2 }}
        >
          {wo.technicianDisplay}
        </Text>
      ) : null}
    </>
  );
}

// ── Phone: banded turn rows ─────────────────────────────────────────────────

/** Band strip separating scheduled from unscheduled turns. */
function BandHeader({ label, color, pad }: { label: string; color: string; pad: number }) {
  const dark = useColorScheme().colorScheme === "dark";
  return (
    <View
      style={{
        paddingHorizontal: pad,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: dark ? "rgba(255,255,255,0.10)" : HAIRLINE,
        backgroundColor: dark ? "rgba(255,255,255,0.04)" : "rgba(9,27,84,0.03)",
      }}
    >
      <Text style={{ fontSize: 10.5, fontWeight: "800", letterSpacing: 0.9, color }}>{label}</Text>
    </View>
  );
}

/**
 * One turn as a full-bleed row: the unit leads with a tinted chip for the
 * stage it's currently on and the move-in chip on the right; the six-segment
 * labeled stage bar sits beneath; and the stage-glyph strip discloses only
 * while the row is expanded.
 */
function TurnRow({
  group,
  nowMs,
  pad,
  expanded,
  onToggle,
}: {
  group: MakeReadyGroup;
  nowMs: number;
  pad: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const dark = useColorScheme().colorScheme === "dark";
  const stage = currentStageOf(group);
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      style={{
        paddingHorizontal: pad,
        paddingVertical: 13,
        gap: 10,
        borderTopWidth: 1,
        borderTopColor: dark ? "rgba(255,255,255,0.10)" : HAIRLINE,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Text className="text-navy dark:text-white" style={{ fontSize: 14.5, fontWeight: "800" }}>
          {group.unitNumber}
        </Text>
        {stage ? <StageChip stage={stage} /> : null}
        {urgencyShowsBadge(group.urgency) ? <UrgencyBadge urgency={group.urgency} /> : null}
        <View style={{ flex: 1 }} />
        <MoveInChip moveInAt={group.moveInAt} nowMs={nowMs} />
        <Ionicons
          name={expanded ? "chevron-down" : "chevron-forward"}
          size={13}
          color={dark ? "rgba(255,255,255,0.3)" : "rgba(9,27,84,0.32)"}
        />
      </View>
      <StageBar group={group} />
      {expanded ? <StageGlyphStrip group={group} /> : null}
    </Pressable>
  );
}

// ── Tablet: frozen-column board ─────────────────────────────────────────────

function BoardHeaderText({ text }: { text: string }) {
  return (
    <Text
      className="text-muted dark:text-white/50"
      numberOfLines={1}
      style={{ fontSize: 8.5, fontWeight: "700", letterSpacing: 0.7 }}
    >
      {text.toUpperCase()}
    </Text>
  );
}

function TabletBoard({ groups, nowMs }: { groups: MakeReadyGroup[]; nowMs: number }) {
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const hairline = dark ? "rgba(255,255,255,0.10)" : HAIRLINE;
  const hairlineSoft = dark ? "rgba(255,255,255,0.07)" : HAIRLINE_SOFT;
  return (
    <AppCardSurface kind="panel" style={{ overflow: "hidden", flexDirection: "row" }}>
      {/* Pinned unit column */}
      <View style={{ width: 190, borderRightWidth: 1, borderRightColor: hairline }}>
        <View style={{ height: HEADER_HEIGHT, justifyContent: "center", paddingHorizontal: 12 }}>
          <BoardHeaderText text="Unit" />
        </View>
        {groups.map((g) => (
          <View
            key={g.unitNumber}
            style={{
              height: CELL_HEIGHT,
              paddingHorizontal: 12,
              paddingVertical: 9,
              justifyContent: "space-between",
              borderTopWidth: 1,
              borderTopColor: hairlineSoft,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text
                className="text-navy dark:text-white"
                numberOfLines={1}
                style={{ flexShrink: 1, fontSize: 13, fontWeight: "700" }}
              >
                {g.unitNumber}
              </Text>
              <ClassificationChip classification={g.classification} />
              <View style={{ flex: 1 }} />
              <Text
                className="text-slate dark:text-white/70"
                style={{ fontSize: 10.5, fontWeight: "700", fontVariant: ["tabular-nums"] }}
              >
                {g.completedStageCount}/{STAGE_COUNT}
              </Text>
            </View>
            <ProgressStrip completed={g.completedStageCount} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Text
                className="text-slate dark:text-white/70"
                numberOfLines={1}
                style={{ flexShrink: 1, fontSize: 9.5 }}
              >
                Move-in {abbreviatedDate(g.moveInAt, nowMs)}
              </Text>
              {urgencyShowsBadge(g.urgency) ? <UrgencyBadge urgency={g.urgency} /> : null}
            </View>
          </View>
        ))}
      </View>
      {/* Scrolling stage columns */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1 }}
      >
        {MAKE_READY_STAGES.map((stage) => (
          <View key={stage} style={{ minWidth: 132, flexGrow: 1 }}>
            <View
              style={{ height: HEADER_HEIGHT, justifyContent: "center", paddingHorizontal: 10 }}
            >
              <BoardHeaderText text={t(`makeReady.stages.${stage}`)} />
            </View>
            {groups.map((g) => {
              const wo = g.stages[stage];
              const done = isStageCompleted(wo);
              return (
                <View
                  key={g.unitNumber}
                  style={{
                    height: CELL_HEIGHT,
                    paddingHorizontal: 10,
                    justifyContent: "center",
                    borderTopWidth: 1,
                    borderTopColor: hairlineSoft,
                    backgroundColor: done ? "rgba(51,166,102,0.13)" : undefined,
                  }}
                >
                  <StageValue wo={wo} />
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </AppCardSurface>
  );
}

// ── Board ───────────────────────────────────────────────────────────────────

export function MakeReadyBoard({
  groups,
  quickCounts,
  quickFilter,
  onQuickFilter,
  showCompleted,
  onToggleShowCompleted,
  nowMs,
  width,
  pad = 20,
}: {
  groups: MakeReadyGroup[];
  quickCounts: Record<MakeReadyQuickFilter, number>;
  quickFilter: MakeReadyQuickFilter;
  onQuickFilter: (f: MakeReadyQuickFilter) => void;
  showCompleted: boolean;
  onToggleShowCompleted: () => void;
  nowMs: number;
  width: number;
  /** Screen edge inset the full-bleed rows use for their content. */
  pad?: number;
}) {
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const tablet = width >= 768;
  const [expandedUnit, setExpandedUnit] = useState<string | null>(null);

  // Quick filter plus the Swift hide-completed rule (unitStatus "Ready" hides).
  const visible = useMemo(
    () =>
      groups.filter(
        (g) => quickFilterIncludes(quickFilter, g) && (showCompleted || !unitIsReady(g)),
      ),
    [groups, quickFilter, showCompleted],
  );

  // The groups arrive dated-first ascending, undated last — the two bands are
  // a straight partition of the already-sorted list.
  const scheduled = useMemo(() => visible.filter((g) => g.moveInAt !== null), [visible]);
  const unscheduled = useMemo(() => visible.filter((g) => g.moveInAt === null), [visible]);

  const renderRow = (g: MakeReadyGroup) => (
    <TurnRow
      key={g.unitNumber}
      group={g}
      nowMs={nowMs}
      pad={pad}
      expanded={expandedUnit === g.unitNumber}
      onToggle={() => setExpandedUnit((prev) => (prev === g.unitNumber ? null : g.unitNumber))}
    />
  );

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginBottom: 12 }}
        contentContainerStyle={{ gap: 6, alignItems: "center", paddingHorizontal: pad }}
      >
        {FILTER_ORDER.map((f) => (
          <FilterChip
            key={f}
            label={t(`makeReady.filters.${f}`)}
            count={quickCounts[f]}
            selected={f === quickFilter}
            onPress={() => onQuickFilter(f)}
          />
        ))}
        <View
          style={{
            width: 1,
            height: 22,
            backgroundColor: dark ? "rgba(255,255,255,0.12)" : "rgba(9,27,84,0.10)",
          }}
        />
        <EyeChip showCompleted={showCompleted} showLabel={tablet} onPress={onToggleShowCompleted} />
      </ScrollView>

      {visible.length === 0 ? (
        <View style={{ paddingVertical: 30, paddingHorizontal: pad + 10, alignItems: "center" }}>
          <Text className="text-navy dark:text-white" style={{ fontSize: 13, fontWeight: "700" }}>
            {t("makeReady.noTurnsMatch")}
          </Text>
          <Text
            className="text-muted dark:text-white/60"
            style={{ fontSize: 11, marginTop: 4, textAlign: "center" }}
          >
            {t(`makeReady.emptyHints.${quickFilter}`)}
          </Text>
        </View>
      ) : tablet ? (
        <View style={{ paddingHorizontal: pad }}>
          <TabletBoard groups={visible} nowMs={nowMs} />
        </View>
      ) : (
        <View>
          {scheduled.length > 0 ? (
            <BandHeader
              label={t("makeReady.bands.scheduled", { count: scheduled.length })}
              color={SCHEDULED_BAND_LABEL}
              pad={pad}
            />
          ) : null}
          {scheduled.map(renderRow)}
          {unscheduled.length > 0 ? (
            <BandHeader
              label={t("makeReady.bands.unscheduled", { count: unscheduled.length })}
              color={dark ? "rgba(255,255,255,0.72)" : "#4C556F"}
              pad={pad}
            />
          ) : null}
          {unscheduled.map(renderRow)}
        </View>
      )}
    </View>
  );
}
