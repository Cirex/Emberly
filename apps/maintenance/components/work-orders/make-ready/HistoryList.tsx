import { useColorScheme } from "nativewind";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import {
  earliestReportedDate,
  latestCompletedDate,
  type MakeReadyGroup,
} from "@/lib/derived/make-ready";
import { abbreviatedDate, calendarDaysBetween, startOfMonth } from "@/lib/derived/time";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE, MUTED } from "@/theme/tokens";

/**
 * Make Ready · History mode: fully completed turns grouped by completion
 * month ("July · N"), each row carrying the unit, classification, a
 * days-in-turn chip (earliest reported → latest completed; green when the
 * turn wrapped in ≤6 days, amber beyond), and the completion date.
 */

const GREEN = "#33A666";
const AMBER = "#B05E14";
const FAST_TURN_DAYS = 6;

interface HistoryEntry {
  group: MakeReadyGroup;
  completedAt: number;
  /** Calendar days from the turn's first reported order to its last
   *  completion — null when the start date is missing. */
  daysInTurn: number | null;
}

function DaysChip({ days }: { days: number }) {
  const { t } = useTranslation();
  const color = days <= FAST_TURN_DAYS ? GREEN : AMBER;
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
        {t("makeReady.history.daysInTurn", { count: days })}
      </Text>
    </View>
  );
}

function BandHeader({ label, pad }: { label: string; pad: number }) {
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
      <Text
        style={{
          fontSize: 10.5,
          fontWeight: "800",
          letterSpacing: 0.9,
          color: dark ? "rgba(255,255,255,0.72)" : "#4C556F",
        }}
      >
        {label}
      </Text>
    </View>
  );
}

function HistoryRow({ entry, nowMs, pad }: { entry: HistoryEntry; nowMs: number; pad: number }) {
  const { group, completedAt, daysInTurn } = entry;
  const dark = useColorScheme().colorScheme === "dark";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: pad,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: dark ? "rgba(255,255,255,0.10)" : HAIRLINE,
      }}
    >
      <Text className="text-navy dark:text-white" style={{ fontSize: 13.5, fontWeight: "800" }}>
        {group.unitNumber}
      </Text>
      {group.classification && group.classification !== "—" ? (
        <Text
          className="text-muted dark:text-white/50"
          numberOfLines={1}
          style={{ flexShrink: 1, fontSize: 10.5 }}
        >
          {group.classification}
        </Text>
      ) : null}
      {daysInTurn !== null ? <DaysChip days={daysInTurn} /> : null}
      <View style={{ flex: 1 }} />
      <Text
        style={{
          fontSize: 11,
          fontWeight: "700",
          fontVariant: ["tabular-nums"],
          color: dark ? "rgba(255,255,255,0.5)" : MUTED,
        }}
      >
        {abbreviatedDate(completedAt, nowMs)}
      </Text>
    </View>
  );
}

export function HistoryList({
  groups,
  nowMs,
  pad,
}: {
  /** Fully completed turns (isFullyCompletedTurn already applied). */
  groups: MakeReadyGroup[];
  nowMs: number;
  pad: number;
}) {
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";

  const months = useMemo(() => {
    const map = new Map<number, HistoryEntry[]>();
    for (const group of groups) {
      // A completed turn without a full completion-date set has no finish
      // month to file under — it stays off the history list.
      const completedAt = latestCompletedDate(group);
      if (completedAt === null) continue;
      const started = earliestReportedDate(group);
      const entry: HistoryEntry = {
        group,
        completedAt,
        daysInTurn:
          started !== null ? Math.max(calendarDaysBetween(started, completedAt), 0) : null,
      };
      const month = startOfMonth(completedAt);
      const list = map.get(month);
      if (list) list.push(entry);
      else map.set(month, [entry]);
    }
    const entries = [...map.entries()].sort((a, b) => b[0] - a[0]);
    for (const [, list] of entries) list.sort((a, b) => b.completedAt - a.completedAt);
    return entries;
  }, [groups]);

  if (months.length === 0) {
    return (
      <Text
        className="text-muted dark:text-white/50"
        style={{ fontSize: 12.5, textAlign: "center", paddingVertical: 24, paddingHorizontal: pad }}
      >
        {t("makeReady.history.empty")}
      </Text>
    );
  }

  const currentYear = new Date(nowMs).getFullYear();

  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: dark ? "rgba(255,255,255,0.10)" : HAIRLINE,
      }}
    >
      {months.map(([month, entries]) => {
        const date = new Date(month);
        const name = date.toLocaleDateString(activeLocale(), { month: "long" });
        const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
        const label =
          date.getFullYear() === currentYear ? capitalized : `${capitalized} ${date.getFullYear()}`;
        return (
          <View key={month}>
            <BandHeader
              label={t("makeReady.history.band", { month: label, count: entries.length })}
              pad={pad}
            />
            {entries.map((entry) => (
              <HistoryRow key={entry.group.unitNumber} entry={entry} nowMs={nowMs} pad={pad} />
            ))}
          </View>
        );
      })}
    </View>
  );
}
