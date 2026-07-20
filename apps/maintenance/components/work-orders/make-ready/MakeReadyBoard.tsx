import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { ClassificationChip, StatusText } from "@/components/work-orders/rows";
import {
  MAKE_READY_STAGES,
  type MakeReadyGroup,
  type MakeReadyQuickFilter,
  type MakeReadyStage,
  type MoveInUrgency,
  QUICK_FILTER_TITLES,
  quickFilterIncludes,
  STAGE_TITLES,
  URGENCY_TITLES,
  urgencyShowsBadge,
} from "@/lib/derived/make-ready";
import { TINT } from "@/lib/derived/status";
import type { ParsedWorkOrder } from "@/lib/derived/types";
import { abbreviatedDate } from "@/lib/derived/time";
import { HAIRLINE, HAIRLINE_SOFT, MUTED, OLIVE, OLIVE_TEXT } from "@/theme/tokens";

/**
 * Make Ready mode: the six-stage turn board. Phone gets stacked turn cards
 * with a 3×2 stage grid; tablet gets the frozen-column board — a pinned unit
 * column beside a horizontally scrolling stage grid, kept in sync by fixed
 * cell heights.
 */

const HEADER_HEIGHT = 38;
const CELL_HEIGHT = 78;
const STAGE_COUNT = MAKE_READY_STAGES.length;

const FILTER_ORDER: MakeReadyQuickFilter[] = ["all", "atRisk", "dueThisWeek", "incomplete", "noMoveInDate"];

const COMPLETED_STATUSES = new Set(["Completed", "Closed"]);

function isStageCompleted(wo: ParsedWorkOrder | null): boolean {
  return wo !== null && COMPLETED_STATUSES.has(wo.status);
}

const URGENCY_BADGE_COLOR: Partial<Record<MoveInUrgency, string>> = {
  overdue: "#D1382E",
  today: "#EB852E",
  nextSevenDays: "#E38736",
};

const EMPTY_HINTS: Record<MakeReadyQuickFilter, string> = {
  all: "No make-ready turns are on the board right now.",
  atRisk: "No incomplete turns are inside the at-risk window.",
  dueThisWeek: "No turns have a move-in today or in the next seven days.",
  incomplete: "Every turn has all six stages completed.",
  noMoveInDate: "Every turn has a move-in date.",
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
        backgroundColor: selected ? "rgba(9,27,84,0.9)" : "transparent",
        borderWidth: 1,
        borderColor: selected ? "transparent" : "rgba(9,27,84,0.16)",
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: "600", color: selected ? "#FFFFFF" : "#4C556F" }}>{label}</Text>
      <Text
        style={{
          fontSize: 11,
          fontWeight: "700",
          fontVariant: ["tabular-nums"],
          color: selected ? "rgba(255,255,255,0.75)" : MUTED,
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
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: showCompleted }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 11,
        height: 34,
        borderRadius: 999,
        backgroundColor: "rgba(255,255,255,0.5)",
        borderWidth: 1,
        borderColor: "rgba(9,27,84,0.12)",
      }}
    >
      <Ionicons name={showCompleted ? "eye-outline" : "eye-off-outline"} size={13} color="#4C556F" />
      {showLabel ? (
        <Text style={{ fontSize: 12, fontWeight: "600", color: "#4C556F" }}>
          {showCompleted ? "Hide Completed" : "Show Completed"}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────

function UrgencyBadge({ urgency }: { urgency: MoveInUrgency }) {
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
        {URGENCY_TITLES[urgency].toUpperCase()}
      </Text>
    </View>
  );
}

/** Six flex capsules — one per stage, filled olive up to completedStageCount. */
function ProgressStrip({ completed }: { completed: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {MAKE_READY_STAGES.map((stage, i) => (
        <View
          key={stage}
          style={{
            flex: 1,
            height: 6,
            borderRadius: 3,
            backgroundColor: i < completed ? OLIVE : "rgba(9,27,84,0.10)",
          }}
        />
      ))}
    </View>
  );
}

// The stage a turn is currently working — the first slot not yet completed —
// drives the row's lead chip. Each stage gets its own tint so the board reads
// at a glance; short labels keep the expanded glyph strip from clipping.
const STAGE_TINT: Record<MakeReadyStage, string> = {
  trashOut: "#70788F",
  punch: "#848F0D",
  flooring: "#2563B4",
  finalInspection: "#5B4BA8",
  cleaning: "#2C8C7A",
  rekey: "#C79433",
};

const SHORT_STAGE_TITLES: Record<MakeReadyStage, string> = {
  trashOut: "Trash",
  punch: "Punch",
  flooring: "Floor",
  finalInspection: "Inspect",
  cleaning: "Clean",
  rekey: "Rekey",
};

function currentStageOf(g: MakeReadyGroup): MakeReadyStage | null {
  return MAKE_READY_STAGES.find((s) => !isStageCompleted(g.stages[s])) ?? null;
}

/** The lead chip: the stage this turn is currently on, tinted per stage. */
function StageChip({ stage }: { stage: MakeReadyStage }) {
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
      <Text style={{ fontSize: 10, fontWeight: "700", color }}>{STAGE_TITLES[stage]}</Text>
    </View>
  );
}

/** Expanded row: the six stages as a labeled circle strip (olive check when
 *  done, empty ring when not) — the mockup's glyph row, no bordered cells. */
function StageGlyphStrip({ group }: { group: MakeReadyGroup }) {
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
                backgroundColor: done ? "rgba(162,169,33,0.18)" : "rgba(9,27,84,0.06)",
              }}
            >
              {done ? (
                <Ionicons name="checkmark" size={15} color={OLIVE_TEXT} />
              ) : (
                <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: "#98A0B4" }} />
              )}
            </View>
            <Text
              numberOfLines={1}
              style={{ fontSize: 8.5, fontWeight: "700", color: done ? OLIVE_TEXT : "#98A0B4" }}
            >
              {SHORT_STAGE_TITLES[stage]}
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
        <Text className="text-muted dark:text-white/50" style={{ fontSize: 10.5, fontWeight: "600" }}>
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

// ── Phone: turn rows ────────────────────────────────────────────────────────

/**
 * One turn as a full-bleed row (Option 2, matching the approved mockup): the
 * unit leads with a tinted chip for the stage it's currently on and the
 * move-in date on the right (red when overdue); the six-segment olive progress
 * strip sits beneath; and the labeled stage-glyph strip discloses only while
 * the row is expanded.
 */
function TurnRow({
  group,
  nowMs,
  pad,
  first,
  expanded,
  onToggle,
}: {
  group: MakeReadyGroup;
  nowMs: number;
  pad: number;
  first: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const stage = currentStageOf(group);
  const overdue = group.urgency === "overdue";
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      style={{
        paddingHorizontal: pad,
        paddingVertical: 13,
        gap: 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: HAIRLINE,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Text className="text-navy dark:text-white" style={{ fontSize: 14.5, fontWeight: "800" }}>
          {group.unitNumber}
        </Text>
        {stage ? <StageChip stage={stage} /> : null}
        {urgencyShowsBadge(group.urgency) ? <UrgencyBadge urgency={group.urgency} /> : null}
        <View style={{ flex: 1 }} />
        {group.moveInAt !== null ? (
          <Text
            style={{
              fontSize: 11,
              fontWeight: "700",
              fontVariant: ["tabular-nums"],
              color: overdue ? TINT.blocked : MUTED,
            }}
          >
            Move-in {abbreviatedDate(group.moveInAt, nowMs)}
          </Text>
        ) : (
          <Text className="text-muted dark:text-white/40" style={{ fontSize: 11, fontWeight: "600" }}>
            No move-in date
          </Text>
        )}
        <Ionicons name={expanded ? "chevron-down" : "chevron-forward"} size={13} color="rgba(9,27,84,0.32)" />
      </View>
      <ProgressStrip completed={group.completedStageCount} />
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
  return (
    <AppCardSurface kind="panel" style={{ overflow: "hidden", flexDirection: "row" }}>
      {/* Pinned unit column */}
      <View style={{ width: 190, borderRightWidth: 1, borderRightColor: HAIRLINE }}>
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
              borderTopColor: HAIRLINE_SOFT,
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
            <View style={{ height: HEADER_HEIGHT, justifyContent: "center", paddingHorizontal: 10 }}>
              <BoardHeaderText text={STAGE_TITLES[stage]} />
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
                    borderTopColor: HAIRLINE_SOFT,
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
  const tablet = width >= 768;
  const [expandedUnit, setExpandedUnit] = useState<string | null>(null);

  // Quick filter plus the Swift hide-completed rule (unitStatus "Ready" hides).
  const visible = useMemo(
    () =>
      groups.filter(
        (g) => quickFilterIncludes(quickFilter, g) && (showCompleted || g.unitStatus !== "Ready"),
      ),
    [groups, quickFilter, showCompleted],
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
            label={QUICK_FILTER_TITLES[f]}
            count={quickCounts[f]}
            selected={f === quickFilter}
            onPress={() => onQuickFilter(f)}
          />
        ))}
        <View style={{ width: 1, height: 22, backgroundColor: "rgba(9,27,84,0.10)" }} />
        <EyeChip showCompleted={showCompleted} showLabel={tablet} onPress={onToggleShowCompleted} />
      </ScrollView>

      {visible.length === 0 ? (
        <View style={{ paddingVertical: 30, paddingHorizontal: pad + 10, alignItems: "center" }}>
          <Text className="text-navy dark:text-white" style={{ fontSize: 13, fontWeight: "700" }}>
            No turns match
          </Text>
          <Text
            className="text-muted dark:text-white/60"
            style={{ fontSize: 11, marginTop: 4, textAlign: "center" }}
          >
            {EMPTY_HINTS[quickFilter]}
          </Text>
        </View>
      ) : tablet ? (
        <View style={{ paddingHorizontal: pad }}>
          <TabletBoard groups={visible} nowMs={nowMs} />
        </View>
      ) : (
        <View style={{ borderTopWidth: 1, borderTopColor: HAIRLINE }}>
          {visible.map((g, i) => (
            <TurnRow
              key={g.unitNumber}
              group={g}
              nowMs={nowMs}
              pad={pad}
              first={i === 0}
              expanded={expandedUnit === g.unitNumber}
              onToggle={() => setExpandedUnit((prev) => (prev === g.unitNumber ? null : g.unitNumber))}
            />
          ))}
        </View>
      )}
    </View>
  );
}
