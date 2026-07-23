import { useTranslation } from "react-i18next";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { Chip } from "@/components/work/primitives";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { InitialsBadge } from "@/components/ui/InitialsBadge";
import { activeLocale } from "@/lib/i18n";
import type { OpenUnitGroup, OpenRow, TimelineTone } from "@/lib/derived/work-boards";
import { HAIRLINE, HAIRLINE_SOFT, MUTED, NAVY, OLIVE } from "@/theme/tokens";

/**
 * Open work orders grouped by unit (mockup frame 03): orders compact under
 * their unit number with the lifetime count and classification, and a timeline
 * rail plots the unit's history. Read-only — a row pushes the order page; the
 * writes stay in the maintenance app.
 */

/** Status/priority text color, matching the board vocabulary. */
const PRIORITY_COLOR: Record<string, string> = {
  Emergency: "#D1382E",
  High: "#B05E14",
  Normal: "#2563B4",
  Low: "#4C556F",
};
const TONE_DOT: Record<TimelineTone, string> = {
  emergency: "#D1382E",
  high: "#E38736",
  normal: "#458ADB",
  low: "#70788F",
  closed: "#C2C6D4",
};

function statusColor(row: OpenRow): string {
  return PRIORITY_COLOR[row.priority] ?? "#2563B4";
}

function monthLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(activeLocale(), { month: "short", day: "numeric" });
}

/** The unit's order history as a horizontal rail of priority-toned dots. */
function TimelineRail({ timeline }: { timeline: NonNullable<OpenUnitGroup["timeline"]> }) {
  const { t } = useTranslation();
  const span = Math.max(1, timeline.endMs - timeline.startMs);
  return (
    <View style={{ gap: 4 }}>
      <View style={{ height: 18, justifyContent: "center" }}>
        {/* baseline */}
        <View style={{ height: 2, borderRadius: 1, backgroundColor: HAIRLINE_SOFT }} />
        {timeline.dots.map((d, i) => {
          const frac = Math.min(1, Math.max(0, (d.atMs - timeline.startMs) / span));
          return (
            <View
              key={i}
              style={{
                position: "absolute",
                left: `${frac * 100}%`,
                marginLeft: -4,
                width: 9,
                height: 9,
                borderRadius: 5,
                borderWidth: 1.5,
                borderColor: "#fff",
                backgroundColor: TONE_DOT[d.tone],
              }}
            />
          );
        })}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 8.5, fontWeight: "700", color: MUTED }}>{monthLabel(timeline.startMs)}</Text>
        <Text style={{ fontSize: 8.5, fontWeight: "700", color: MUTED }}>{t("work.open.today")}</Text>
      </View>
    </View>
  );
}

function UnitLine({ row, onPress, last }: { row: OpenRow; onPress: () => void; last: boolean }) {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.number} · ${row.title}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 6,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: HAIRLINE_SOFT,
      }}
    >
      <Text style={{ width: 46, fontSize: 10.5, fontWeight: "700", color: MUTED, fontVariant: ["tabular-nums"] }}>
        {row.number ? `#${row.number}` : "—"}
      </Text>
      <Text style={{ width: 70, fontSize: 11, fontWeight: "700", color: statusColor(row) }} numberOfLines={1}>
        {row.status || "—"}
      </Text>
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: NAVY }}>
        {row.title || "—"}
      </Text>
      <Text style={{ fontSize: 10, fontWeight: "700", color: MUTED, fontVariant: ["tabular-nums"] }}>
        {t("work.days", { count: row.ageDays })}
      </Text>
      <InitialsBadge name={row.technicianDisplay} size={22} />
    </Pressable>
  );
}

function UnitGroupCard({ group, onOpenRow }: { group: OpenUnitGroup; onOpenRow: (id: string) => void }) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const wide = width >= 1040;
  const isUrgent = group.lines.some((l) => l.priority === "Emergency");

  const main = (
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <Text style={{ fontSize: 13.5, fontWeight: "800", color: NAVY }}>{group.unitNumber || "—"}</Text>
        {group.classification ? <Chip label={group.classification} tone="neutral" /> : null}
        <Text style={{ fontSize: 9.5, fontWeight: "800", color: MUTED }}>
          {group.totalCount > group.openCount
            ? t("work.open.countTotal", { open: group.openCount, total: group.totalCount })
            : t("work.open.countOpen", { open: group.openCount })}
        </Text>
        {group.anyCallback ? (
          <View style={{ marginLeft: "auto" }}>
            <Chip label={t("work.open.callbackRisk")} tone="callback" />
          </View>
        ) : null}
      </View>
      {group.lines.map((row, i) => (
        <UnitLine key={row.id} row={row} onPress={() => onOpenRow(row.id)} last={i === group.lines.length - 1} />
      ))}
    </View>
  );

  const side =
    group.timeline !== null ? (
      <TimelineRail timeline={group.timeline} />
    ) : group.closedCount > 0 ? (
      <Text style={{ fontSize: 9.5, fontWeight: "600", color: MUTED }}>
        {t("work.open.historyClosed", {
          count: group.closedCount,
          date: group.lastClosedAt ? monthLabel(group.lastClosedAt) : "—",
        })}
      </Text>
    ) : (
      <Text style={{ fontSize: 9.5, fontWeight: "600", color: MUTED }}>{t("work.open.historyFirst")}</Text>
    );

  return (
    <AppCardSurface
      kind="panel"
      style={{
        paddingHorizontal: 16,
        paddingVertical: 12,
        marginBottom: 10,
        ...(isUrgent ? { borderLeftWidth: 3, borderLeftColor: OLIVE } : null),
      }}
    >
      {wide ? (
        <View style={{ flexDirection: "row", gap: 20, alignItems: "center" }}>
          {main}
          <View style={{ width: 200, borderLeftWidth: 1, borderLeftColor: HAIRLINE, paddingLeft: 18, justifyContent: "center" }}>
            {side}
          </View>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          {main}
          <View style={{ borderTopWidth: 1, borderTopColor: HAIRLINE, paddingTop: 8 }}>{side}</View>
        </View>
      )}
    </AppCardSurface>
  );
}

export function OpenBoard({
  groups,
  onOpenRow,
}: {
  groups: OpenUnitGroup[];
  onOpenRow: (id: string) => void;
}) {
  const { t } = useTranslation();

  if (groups.length === 0) {
    return (
      <AppCardSurface kind="panel" style={{ padding: 26, alignItems: "center" }}>
        <Text style={{ fontSize: 12, color: MUTED, textAlign: "center" }}>{t("work.open.empty")}</Text>
      </AppCardSurface>
    );
  }

  return (
    <View>
      {groups.map((group) => (
        <UnitGroupCard key={group.unitNumber || "—"} group={group} onOpenRow={onOpenRow} />
      ))}
    </View>
  );
}
