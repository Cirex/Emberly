import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ClassificationChip, TechBadge } from "@/components/work-orders/rows";
import { timelineGapTitle, type OpenWorkOrderGroup, type TimelineEvent } from "@/lib/derived/open-groups";
import { classificationColor, workOrderStatusColor } from "@/lib/derived/status";
import { tagIconName } from "@/lib/derived/tags";
import { abbreviatedDate, calendarDaysBetween, startOfDay } from "@/lib/derived/time";
import type { ParsedWorkOrder } from "@/lib/derived/types";
import { CALLBACK_TINT } from "@/theme/tokens";
import { useTranslated } from "@/lib/translation/use-translated";
import { useTranslation } from "react-i18next";
import { statusLabel } from "@/lib/derived/resman-labels";

const RAIL_TINTS = {
  blocked: "#D1382E",
  attention: "#EB852E",
  warning: "#E38736",
  secondary: "#9AA2B5",
} as const;

const DUPLICATE_TINT = "#2563B4";
const ATTENTION_TINT = "#EB852E";
const MOVE_IN_TINT = "#33A666";
/** Stable per-event dot accents (Swift metricAccent(stableTimelineAccentIndex)). */
const DOT_ACCENTS = ["#458ADB", "#3D9461", "#7A6BC7", "#D19438"] as const;

/** Hash of the event's work-order identities → stable accent (Swift parity:
 *  the same unit's dots keep their colors across rebuilds). */
function dotAccent(e: TimelineEvent): string {
  let h = 0;
  for (const wo of e.workOrders) for (let i = 0; i < wo.id.length; i++) h = (h + wo.id.charCodeAt(i)) % 997;
  return DOT_ACCENTS[h % DOT_ACCENTS.length];
}

const RAIL_INSET = 8;
const MIN_GAP_LABEL_PX = 54;

/**
 * The reported-date mini timeline — port of openWorkOrderTimeline: endpoint
 * date labels, signal-tinted dots (count badges / embedded tag glyphs), gap
 * labels between spread-out dots, an age-tinted rail, the move-in stem marker
 * and the move-in → first-issue attention bridge. Shown only when the group
 * has history worth plotting (>1 work order, or a recent move-in).
 */
function TimelineRail({ group, nowMs }: { group: OpenWorkOrderGroup; nowMs: number }) {
  const [width, setWidth] = useState(0);
  // Both hooks stay ABOVE the early return below — Rules of Hooks.
  const { t } = useTranslation();
  const { timeline: events, timelineOverflow, moveIn, firstIssueAfterMoveIn } = group;
  if (events.length === 0 || (group.workOrders.length <= 1 && moveIn === null)) return null;

  const railColor = RAIL_TINTS[group.railTint];
  const x = (position: number) =>
    RAIL_INSET + (width - RAIL_INSET * 2) * Math.min(Math.max(position, 0), 1);

  // Domain comes from the group — the view used to recompute it from the events
  // alone, which meant a move-in that predates the first work order had nowhere
  // to plot and clamped onto the first dot.
  const firstDay = group.railStartMs;
  const lastDay = group.railEndMs;
  const moveInX = moveIn !== null ? x(moveIn.position) : null;
  const firstIssueX =
    firstIssueAfterMoveIn !== null ? x(events[firstIssueAfterMoveIn.eventIndex].position) : null;

  // Gap labels only where the dots are far enough apart to fit one. They sit
  // INLINE on the rail (mockup style), so the rail breaks around each label.
  const gaps: { mid: number; title: string; highlight: boolean }[] = [];
  if (width > 0) {
    for (let i = 1; i < events.length; i++) {
      const a = x(events[i - 1].position);
      const b = x(events[i].position);
      if (b - a >= MIN_GAP_LABEL_PX) {
        gaps.push({
          mid: (a + b) / 2,
          title: timelineGapTitle(calendarDaysBetween(events[i - 1].dayMs, events[i].dayMs)),
          highlight: events[i].isFirstIssueAfterMoveIn,
        });
      }
    }
  }

  // Rail segments: dot-to-dot (plus the leading/trailing runs to the card
  // edges), split around any inline label. Older segments render fainter, so
  // the rail visually "heats up" toward the latest event.
  const LABEL_HALF = 26;
  const segments: { from: number; to: number; alpha: number }[] = [];
  if (width > 0) {
    const bounds = [5, ...events.map((e) => x(e.position)), width - 5]
      .sort((a, b) => a - b)
      .filter((v, i, arr) => i === 0 || v - arr[i - 1] > 1);
    const n = Math.max(bounds.length - 1, 1);
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i];
      const b = bounds[i + 1];
      const alpha = 0.2 + 0.45 * (i / n);
      const label = gaps.find((g) => g.mid > a && g.mid < b);
      if (label && label.mid - LABEL_HALF - a > 4 && b - (label.mid + LABEL_HALF) > 4) {
        segments.push({ from: a, to: label.mid - LABEL_HALF, alpha });
        segments.push({ from: label.mid + LABEL_HALF, to: b, alpha });
      } else {
        segments.push({ from: a, to: b, alpha });
      }
    }
  }
  const alphaHex = (a: number) =>
    Math.round(Math.min(Math.max(a, 0), 1) * 255)
      .toString(16)
      .padStart(2, "0");

  // When the rail starts at the move-in, the left endpoint IS the move-in date —
  // say so, rather than printing a bare date the marker alone has to explain.
  const startsAtMoveIn = moveIn !== null && moveIn.dayMs <= events[0].dayMs;
  const startLabel = abbreviatedDate(firstDay, nowMs);
  const endLabel = abbreviatedDate(lastDay, nowMs);
  return (
    <View style={{ marginTop: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 2, marginBottom: 3 }}>
        <Text
          className={startsAtMoveIn ? undefined : "text-muted dark:text-white/50"}
          style={{
            fontSize: 10,
            fontWeight: startsAtMoveIn ? "700" : "500",
            color: startsAtMoveIn ? MOVE_IN_TINT : undefined,
          }}
        >
          {startsAtMoveIn ? t("workOrders.timeline.movedIn", { date: startLabel }) : startLabel}
        </Text>
        <Text className="text-muted dark:text-white/50" style={{ fontSize: 10, fontWeight: "500" }}>
          {lastDay === startOfDay(nowMs) ? t("workOrders.closed.band.today") : endLabel}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View
          style={{ flex: 1, height: 34 }}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        >
          {width > 0 ? (
            <>
              {/* Rail segments — broken around inline labels, fading toward
                  the oldest end, tinted by the oldest issue's age. */}
              {segments.map((s) => (
                <View
                  key={`${s.from}-${s.to}`}
                  style={{
                    position: "absolute",
                    left: s.from,
                    width: Math.max(s.to - s.from, 0),
                    top: 18.5,
                    height: 3,
                    borderRadius: 1.5,
                    backgroundColor: `${railColor}${alphaHex(s.alpha)}`,
                  }}
                />
              ))}
              {/* Move-in → first-issue bridge (attention tint). */}
              {moveInX !== null && firstIssueX !== null && firstIssueX > moveInX ? (
                <View
                  style={{
                    position: "absolute",
                    left: moveInX,
                    width: firstIssueX - moveInX,
                    top: 18.5,
                    height: 3,
                    borderRadius: 1.5,
                    backgroundColor: `${ATTENTION_TINT}CC`,
                  }}
                />
              ) : null}
              {/* Inline gap labels, centered on the rail line. */}
              {gaps.map((g) => (
                <Text
                  key={g.mid}
                  numberOfLines={1}
                  style={{
                    position: "absolute",
                    left: g.mid - LABEL_HALF,
                    width: LABEL_HALF * 2,
                    top: 13.5,
                    textAlign: "center",
                    fontSize: 9.5,
                    fontWeight: g.highlight ? "700" : "600",
                    color: g.highlight ? ATTENTION_TINT : "#8A92A6",
                  }}
                >
                  {g.title}
                </Text>
              ))}
              {/* Move-in stem marker. */}
              {moveInX !== null ? (
                <View
                  style={{
                    position: "absolute",
                    left: moveInX - 5,
                    top: 3,
                    width: 10,
                    alignItems: "center",
                  }}
                >
                  <MaterialCommunityIcons name="account-plus" size={8} color={MOVE_IN_TINT} />
                  <View style={{ width: 1.2, height: 9, backgroundColor: MOVE_IN_TINT, borderRadius: 0.6 }} />
                </View>
              ) : null}
              {/* Dots. */}
              {events.map((e, i) => {
                const latest = i === events.length - 1;
                const signalTint =
                  e.signal === "callback" ? CALLBACK_TINT : e.signal === "duplicate" ? DUPLICATE_TINT : null;
                const tint = signalTint ?? dotAccent(e);
                const single = e.workOrders.length === 1;
                const primaryTag = single ? e.workOrders[0].tags[0] : undefined;
                // A glyph-bearing dot renders at the full hit size; a plain
                // dot stays small on the rail (Swift 10/8 core, 16/14 frame).
                const glyph =
                  single && e.signal
                    ? e.signal === "callback"
                      ? "arrow-u-left-top"
                      : "content-duplicate"
                    : single && primaryTag
                      ? tagIconName(primaryTag, true)
                      : null;
                const big = glyph !== null || !single;
                const size = big ? (latest ? 16 : 14) : latest ? 10 : 8;
                const cx = x(e.position);
                return (
                  <View
                    key={e.dayMs}
                    style={{
                      position: "absolute",
                      left: cx - size / 2,
                      top: 20 - size / 2,
                      width: size,
                      height: size,
                    }}
                  >
                    {e.isFirstIssueAfterMoveIn || latest ? (
                      <View
                        style={{
                          position: "absolute",
                          left: size / 2 - (size + 6) / 2,
                          top: size / 2 - (size + 6) / 2,
                          width: size + 6,
                          height: size + 6,
                          borderRadius: (size + 6) / 2,
                          borderWidth: 2,
                          borderColor: e.isFirstIssueAfterMoveIn ? `${ATTENTION_TINT}CC` : `${tint}45`,
                        }}
                      />
                    ) : null}
                    <View
                      style={{
                        width: size,
                        height: size,
                        borderRadius: size / 2,
                        backgroundColor: tint,
                        borderWidth: 1,
                        borderColor: `${tint}61`,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {glyph ? (
                        <MaterialCommunityIcons name={glyph as never} size={7} color="#FFFFFF" />
                      ) : !single ? (
                        <Text style={{ fontSize: 7.5, fontWeight: "700", color: "#FFFFFF" }}>
                          {e.workOrders.length}
                        </Text>
                      ) : null}
                    </View>
                    {/* Signal badge for dots that couldn't merge it into the glyph. */}
                    {e.signal && !(single && glyph) ? (
                      <View
                        style={{
                          position: "absolute",
                          right: -4,
                          top: -4,
                          width: 10,
                          height: 10,
                          borderRadius: 5,
                          backgroundColor: "#FFFFFF",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <MaterialCommunityIcons
                          name={e.signal === "callback" ? "arrow-u-left-top" : "content-duplicate"}
                          size={6}
                          color={signalTint ?? tint}
                        />
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </>
          ) : null}
        </View>
        {timelineOverflow > 0 ? (
          <View
            style={{
              marginLeft: 6,
              paddingHorizontal: 5,
              paddingVertical: 2,
              borderRadius: 999,
              backgroundColor: "rgba(112,120,143,0.14)",
            }}
          >
            <Text className="text-muted" style={{ fontSize: 9, fontWeight: "700" }}>
              +{timelineOverflow}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function TagChip({ tag, count, signal }: { tag: string; count: number; signal: "callback" | "duplicate" | null }) {
  const color = signal === "callback" ? CALLBACK_TINT : signal === "duplicate" ? DUPLICATE_TINT : "#2A66AC";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 4.5,
        borderRadius: 999,
        backgroundColor: `${color}14`,
        borderWidth: 1,
        borderColor: `${color}42`,
      }}
    >
      <MaterialCommunityIcons name={tagIconName(tag) as never} size={12} color={color} />
      <Text style={{ fontSize: 11, fontWeight: "600", color }}>
        {tag}
        {count > 1 ? ` · ${count}` : ""}
      </Text>
    </View>
  );
}

/**
 * One work order as a SLIM line inside the zone-washed group (approved D3
 * rev 2): the ticket id stacked over its reported date in a fixed left
 * column, the one-line title with its status colored beneath, and the
 * technician's badge on the right. Signals and tags live at the group level
 * (timeline dots + the bottom chips row), so the row stays quiet.
 */
function WorkOrderTicket({
  wo,
  nowMs,
  onPress,
  first,
  pad,
}: {
  wo: ParsedWorkOrder;
  nowMs: number;
  onPress: () => void;
  first: boolean;
  pad: number;
}) {
  const { t } = useTranslation();
  const tr = useTranslated();
  const statusColor = workOrderStatusColor(wo.status);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        paddingVertical: 8.5,
        paddingLeft: pad - 3.5,
        paddingRight: pad,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: "rgba(9,27,84,0.05)",
      }}
    >
      <View style={{ width: 48, flexShrink: 0 }}>
        <Text
          className="text-muted dark:text-white/50"
          style={{ fontSize: 10, fontWeight: "800", fontVariant: ["tabular-nums"] }}
        >
          #{wo.number}
        </Text>
        <Text
          className="text-slate dark:text-white/60"
          style={{ fontSize: 8.5, fontWeight: "700", fontVariant: ["tabular-nums"], marginTop: 1, opacity: 0.8 }}
        >
          {abbreviatedDate(wo.reportedAt, nowMs)}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          className="text-navy dark:text-white"
          numberOfLines={1}
          style={{ fontSize: 12.5, fontWeight: "700", letterSpacing: -0.1 }}
        >
          {tr(wo.title).shown || "Untitled work order"}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 10, fontWeight: "700", color: statusColor, marginTop: 1 }}>
          {statusLabel(t, wo.status)}
        </Text>
      </View>
      {wo.technicianDisplay !== "Unassigned" ? <TechBadge name={wo.technicianDisplay} size={22} /> : null}
    </Pressable>
  );
}

/** Hex alpha suffixes for the zone wash's fade stops. */
const WASH_TOP = "13"; // ~7.5%
const WASH_MID = "07"; // ~2.8%

/**
 * Open mode, approved D3 rev 2 (artifact 480091ba): each unit is a ZONE — a
 * classification-tinted rail down the left edge with a matching wash that
 * fades out over the group's height. The band leads with unit + count +
 * classification (dates moved into each row), the timeline keeps its place,
 * the slim ticket rows follow, and every tag the unit's tickets carry
 * collects in one chips row that closes the group. Tapping the band still
 * collapses a noisy unit down to band + timeline + chips (rows hidden);
 * `expanded` therefore means "rows shown", the default presentation.
 * ≥768pt keeps the aligned table for the rows.
 *
 * Memoized: a card is a gradient, a laid-out timeline rail and every ticket row
 * in the unit, and the board keeps a screenful mounted. Without this, any parent
 * render — a sync tick, a filter toggle — re-rendered all of them. The props are
 * stable by construction: groups come from the derived snapshot, `nowMs` from
 * the minute clock, and `onToggle` from a memoized callback.
 */
export const OpenGroupCard = memo(function OpenGroupCard({
  group,
  expanded,
  onToggle,
  nowMs,
  pad = 20,
}: {
  group: OpenWorkOrderGroup;
  expanded: boolean;
  /** Takes the unit so the parent can pass ONE stable callback for every card —
   *  a per-row arrow function would change identity each render and defeat the
   *  memo above. */
  onToggle: (unitNumber: string) => void;
  nowMs: number;
  pad?: number;
}) {
  const router = useRouter();
  const tint = classificationColor(group.classification);
  const collapsed = !expanded;
  return (
    <View style={{ borderLeftWidth: 3.5, borderLeftColor: tint }}>
      {/* The zone wash: strongest at the band, gone by the group's end. */}
      <LinearGradient
        colors={[`${tint}${WASH_TOP}`, `${tint}${WASH_MID}`, `${tint}00`]}
        locations={[0, 0.46, 1]}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <Pressable
        onPress={() => onToggle(group.unitNumber)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
      >
        <View style={{ paddingLeft: pad - 3.5, paddingRight: pad, paddingTop: 11, paddingBottom: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text className="text-navy dark:text-white" style={{ fontSize: 16, fontWeight: "800" }}>
              {group.unitNumber}
            </Text>
            <View
              style={{
                paddingHorizontal: 8,
                paddingVertical: 1.5,
                borderRadius: 999,
                backgroundColor: "rgba(9,27,84,0.08)",
              }}
            >
              <Text className="text-slate dark:text-white/70" style={{ fontSize: 10.5, fontWeight: "800", fontVariant: ["tabular-nums"] }}>
                {group.workOrders.length}
              </Text>
            </View>
            <ClassificationChip classification={group.classification} />
            <View style={{ flex: 1 }} />
            {collapsed ? (
              <Text
                className="text-muted dark:text-white/50"
                style={{ fontSize: 10.5, fontWeight: "700", fontVariant: ["tabular-nums"] }}
              >
                {abbreviatedDate(group.latestDateMs, nowMs)}
              </Text>
            ) : null}
            <Ionicons name={expanded ? "chevron-down" : "chevron-forward"} size={14} color="rgba(9,27,84,0.32)" />
          </View>
          <TimelineRail group={group} nowMs={nowMs} />
        </View>
      </Pressable>

      {/* The rows — the default presentation; a collapsed unit hides them.
          The slim anatomy holds on every width (the old per-group column
          tables repeated their headers on iPad and fought the zones). */}
      {expanded ? (
        <View>
          {group.workOrders.map((wo, i) => (
            <WorkOrderTicket
              key={wo.id}
              wo={wo}
              nowMs={nowMs}
              first={i === 0}
              pad={pad}
              onPress={() => router.push(`/work-order/${wo.id}`)}
            />
          ))}
        </View>
      ) : null}

      {/* Every tag the unit carries, closing the group. A collapsed unit adds
          the technician badges here so that context survives without rows. */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          paddingLeft: pad - 3.5,
          paddingRight: pad,
          paddingTop: 5,
          paddingBottom: 11,
        }}
      >
        {group.topTags.map((t) => (
          <TagChip key={t.tag} tag={t.tag} count={t.count} signal={t.signal} />
        ))}
        {group.callbackWorkOrderIds.length > 0 ? (
          <TagChip tag="Callback" count={group.callbackWorkOrderIds.length} signal="callback" />
        ) : null}
        {group.hasPossibleDuplicate ? <TagChip tag="Duplicate" count={1} signal="duplicate" /> : null}
        {collapsed ? (
          <>
            <View style={{ flex: 1 }} />
            <View style={{ flexDirection: "row" }}>
              {group.technicians.slice(0, 3).map((t, i) => (
                <View key={t} style={{ marginLeft: i === 0 ? 0 : -6 }}>
                  <TechBadge name={t} size={22} />
                </View>
              ))}
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
});
