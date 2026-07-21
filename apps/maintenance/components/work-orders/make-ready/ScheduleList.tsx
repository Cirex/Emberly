import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { currentStageOf, MAKE_READY_STAGES, type MakeReadyGroup } from "@/lib/derived/make-ready";
import { calendarDaysBetween, startOfDay } from "@/lib/derived/time";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE, MUTED } from "@/theme/tokens";

/**
 * Make Ready · Schedule mode: the turns with a move-in date grouped by day —
 * "Today", then each upcoming weekday — as compact cards (unit · current
 * stage · days out/late), followed by an "Unscheduled" band listing the rest
 * compactly. Pure re-grouping of the board's groups; no new data.
 */

const RED = "#D1382E";

function BandLabel({ text, pad }: { text: string; pad: number }) {
  return (
    <Text
      className="text-muted dark:text-white/50"
      style={{
        fontSize: 10.5,
        fontWeight: "800",
        letterSpacing: 1,
        marginHorizontal: pad,
        marginBottom: 8,
      }}
    >
      {text.toUpperCase()}
    </Text>
  );
}

/** Compact card: unit · current stage name · days-out/late tag. */
function ScheduleCard({ group, nowMs, pad }: { group: MakeReadyGroup; nowMs: number; pad: number }) {
  const { t } = useTranslation();
  const stage = currentStageOf(group);
  const days = calendarDaysBetween(nowMs, group.moveInAt ?? nowMs);
  const late = days < 0;
  return (
    <View
      style={{
        marginHorizontal: pad,
        marginBottom: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: HAIRLINE,
        backgroundColor: "rgba(255,255,255,0.55)",
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}
    >
      <Text className="text-navy dark:text-white" style={{ fontSize: 14, fontWeight: "800" }}>
        {group.unitNumber}
      </Text>
      <Text className="text-slate dark:text-white/70" numberOfLines={1} style={{ flex: 1, fontSize: 11.5 }}>
        {stage ? t(`makeReady.stages.${stage}`) : t("makeReady.complete")}
      </Text>
      <Text
        style={{
          fontSize: 11,
          fontWeight: "700",
          fontVariant: ["tabular-nums"],
          color: late ? RED : MUTED,
        }}
      >
        {late
          ? t("makeReady.schedule.daysLate", { count: -days })
          : days === 0
            ? t("makeReady.schedule.today")
            : t("makeReady.schedule.daysOut", { count: days })}
      </Text>
    </View>
  );
}

/** One unscheduled turn, compactly: unit · current stage · stage count. */
function UnscheduledRow({ group, pad }: { group: MakeReadyGroup; pad: number }) {
  const { t } = useTranslation();
  const stage = currentStageOf(group);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: pad,
        paddingVertical: 9,
        borderTopWidth: 1,
        borderTopColor: HAIRLINE,
      }}
    >
      <Text className="text-navy dark:text-white" style={{ fontSize: 13.5, fontWeight: "800" }}>
        {group.unitNumber}
      </Text>
      <Text className="text-slate dark:text-white/70" numberOfLines={1} style={{ flex: 1, fontSize: 11.5 }}>
        {stage ? t(`makeReady.stages.${stage}`) : t("makeReady.complete")}
      </Text>
      <Text
        className="text-muted dark:text-white/50"
        style={{ fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] }}
      >
        {group.completedStageCount}/{MAKE_READY_STAGES.length}
      </Text>
    </View>
  );
}

export function ScheduleList({
  groups,
  nowMs,
  pad,
}: {
  groups: MakeReadyGroup[];
  nowMs: number;
  pad: number;
}) {
  const { t } = useTranslation();
  const today = startOfDay(nowMs);

  const { days, unscheduled } = useMemo(() => {
    const map = new Map<number, MakeReadyGroup[]>();
    const rest: MakeReadyGroup[] = [];
    for (const g of groups) {
      if (g.moveInAt === null) {
        rest.push(g);
        continue;
      }
      const day = startOfDay(g.moveInAt);
      const list = map.get(day);
      if (list) list.push(g);
      else map.set(day, [g]);
    }
    return { days: [...map.entries()].sort((a, b) => a[0] - b[0]), unscheduled: rest };
  }, [groups]);

  if (groups.length === 0) {
    return (
      <Text
        className="text-muted dark:text-white/50"
        style={{ fontSize: 12.5, textAlign: "center", paddingVertical: 24, paddingHorizontal: pad }}
      >
        {t("makeReady.schedule.empty")}
      </Text>
    );
  }

  return (
    <View>
      {days.map(([day, dayGroups]) => (
        <View key={day} style={{ marginBottom: 8 }}>
          <BandLabel
            pad={pad}
            text={
              day === today
                ? t("makeReady.schedule.today")
                : new Date(day).toLocaleDateString(activeLocale(), {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })
            }
          />
          {dayGroups.map((g) => (
            <ScheduleCard key={g.unitNumber} group={g} nowMs={nowMs} pad={pad} />
          ))}
        </View>
      ))}
      {unscheduled.length > 0 ? (
        <View style={{ marginTop: days.length > 0 ? 8 : 0 }}>
          <BandLabel pad={pad} text={t("makeReady.schedule.unscheduled", { count: unscheduled.length })} />
          <View style={{ borderBottomWidth: 1, borderBottomColor: HAIRLINE }}>
            {unscheduled.map((g) => (
              <UnscheduledRow key={g.unitNumber} group={g} pad={pad} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}
