import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View, Pressable } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import type { MyWeek } from "@/lib/derived/my-week";
import { HAIRLINE, MUTED, NAVY, OLIVE, OLIVE_TEXT } from "@/theme/tokens";

const GREEN = "#33A666";
const AMBER = "#B05E14";

/**
 * The technician's own week — the retrospective half of My Day.
 *
 * Everything here is derived from work orders already synced (see
 * lib/derived/my-week.ts), so this panel makes no request and adds no state.
 * It sits beside My Day in a pager rather than in its own tab: same person,
 * same data, one horizon forward and one back.
 */
export function MyWeekPanel({
  week,
  pad,
  topInset,
  bottomInset,
  onBack,
}: {
  week: MyWeek;
  pad: number;
  topInset: number;
  bottomInset: number;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const initials = week.technician
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingTop: topInset + 10, paddingBottom: bottomInset + 110, paddingHorizontal: pad }}
      showsVerticalScrollIndicator={false}
    >
      {/* Back to My Day — the pager's only other exit, so it leads. */}
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel={t("myWeek.backToMyDay")}
        style={{
          alignSelf: "flex-start",
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingVertical: 7,
          paddingLeft: 10,
          paddingRight: 14,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: HAIRLINE,
          marginBottom: 14,
        }}
      >
        <Ionicons name="chevron-back" size={15} color={NAVY} />
        <Text className="text-navy dark:text-white" style={{ fontSize: 13, fontWeight: "800" }}>
          {t("myWeek.backToMyDay")}
        </Text>
      </Pressable>

      {/* Who and when */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 13 }}>
        <View
          style={{
            width: 46,
            height: 46,
            borderRadius: 23,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(51,166,102,0.14)",
          }}
        >
          <Text style={{ fontSize: 16, fontWeight: "800", color: "#2C6B44" }}>{initials || "—"}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            className="text-navy dark:text-white"
            numberOfLines={1}
            style={{ fontSize: 19, fontWeight: "800", letterSpacing: -0.3 }}
          >
            {week.technician || t("myWeek.you")}
          </Text>
          <Text className="text-muted dark:text-white/50" style={{ fontSize: 11.5, marginTop: 1 }}>
            {t("myWeek.weekOf", { range: week.weekLabel })}
          </Text>
        </View>
      </View>

      {/* Scorecards */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 11, marginTop: 16 }}>
        <ScoreCard
          label={t("myWeek.closed")}
          value={String(week.thisWeek.closed)}
          detail={
            week.closedDelta === 0
              ? t("myWeek.sameAsLastWeek")
              : week.closedDelta > 0
                ? t("myWeek.upVsLastWeek", { count: week.closedDelta })
                : t("myWeek.downVsLastWeek", { count: Math.abs(week.closedDelta) })
          }
        />
        <ScoreCard
          label={t("myWeek.medianClose")}
          value={week.thisWeek.medianDaysToClose === null ? "—" : `${round1(week.thisWeek.medianDaysToClose)}d`}
          detail={
            week.thisWeek.medianDaysToClose === null
              ? t("myWeek.nothingClosed")
              : t("myWeek.lastWeekWas", {
                  value:
                    week.lastWeek.medianDaysToClose === null
                      ? "—"
                      : `${round1(week.lastWeek.medianDaysToClose)}d`,
                })
          }
          tint={week.thisWeek.medianDaysToClose !== null && week.thisWeek.medianDaysToClose <= 4 ? GREEN : undefined}
        />
        <ScoreCard
          label={t("myWeek.callbackRate")}
          // A percentage off two jobs is noise, so it is withheld rather than
          // shown as a number the tech might take to heart.
          value={week.callbackSmallSample ? "—" : `${(week.callbackRate * 100).toFixed(1)}%`}
          detail={
            week.callbackSmallSample
              ? t("myWeek.tooFewToRate")
              : t("myWeek.callbacksInDays", { count: week.callbackCount, days: 90 })
          }
          tint={!week.callbackSmallSample && week.callbackRate <= 0.05 ? GREEN : undefined}
        />
        <ScoreCard
          label={t("myWeek.onRouteToday")}
          value={String(week.onRouteToday)}
          detail={week.urgentToday > 0 ? t("myWeek.urgentCount", { count: week.urgentToday }) : t("myWeek.noneUrgent")}
          tint={week.urgentToday > 0 ? AMBER : undefined}
        />
      </View>

      {/* Closes per day */}
      <AppCardSurface kind="panel" style={{ marginTop: 16, padding: 15 }}>
        <Text
          className="text-muted dark:text-white/50"
          style={{ fontSize: 10, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" }}
        >
          {t("myWeek.closesPerDay")}
        </Text>
        <DayChart week={week} />
      </AppCardSurface>

      {/* Streak */}
      <View
        style={{
          marginTop: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: "rgba(162,169,33,0.28)",
          backgroundColor: "rgba(162,169,33,0.10)",
          paddingVertical: 13,
          paddingHorizontal: 15,
        }}
      >
        <Ionicons name="star" size={14} color={OLIVE_TEXT} />
        <Text style={{ flex: 1, fontSize: 12.5, fontWeight: "700", color: OLIVE_TEXT }}>
          {week.streakAtWindowCap
            ? t("myWeek.streakClean", { days: week.callbackFreeStreakDays })
            : t("myWeek.streakDays", { count: week.callbackFreeStreakDays })}
        </Text>
      </View>

      {/* Last week, muted — context for this week, not a headline of its own. */}
      <View
        style={{
          marginTop: 12,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: HAIRLINE,
          paddingVertical: 12,
          paddingHorizontal: 14,
        }}
      >
        <Text
          className="text-muted dark:text-white/50"
          style={{ fontSize: 9.5, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}
        >
          {t("myWeek.lastWeekRange", { range: week.lastWeekLabel })}
        </Text>
        <View style={{ flexDirection: "row" }}>
          <LastWeekStat label={t("myWeek.closed")} value={String(week.lastWeek.closed)} />
          <LastWeekStat
            label={t("myWeek.medianClose")}
            value={week.lastWeek.medianDaysToClose === null ? "—" : `${round1(week.lastWeek.medianDaysToClose)}d`}
            divider
          />
        </View>
      </View>
    </ScrollView>
  );
}

function round1(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function ScoreCard({
  label,
  value,
  detail,
  tint,
}: {
  label: string;
  value: string;
  detail: string;
  tint?: string;
}) {
  return (
    <AppCardSurface kind="panel" style={{ flexGrow: 1, flexBasis: "45%", padding: 14 }}>
      <Text
        className="text-muted dark:text-white/50"
        style={{ fontSize: 9.5, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase" }}
      >
        {label}
      </Text>
      <Text
        className={tint ? "" : "text-navy dark:text-white"}
        style={{
          fontSize: 28,
          fontWeight: "800",
          letterSpacing: -0.6,
          marginTop: 3,
          fontVariant: ["tabular-nums"],
          ...(tint ? { color: tint } : {}),
        }}
      >
        {value}
      </Text>
      <Text className="text-muted dark:text-white/50" style={{ fontSize: 10.5, marginTop: 2 }}>
        {detail}
      </Text>
    </AppCardSurface>
  );
}

function LastWeekStat({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return (
    <View
      style={{
        flex: 1,
        borderLeftWidth: divider ? 1 : 0,
        borderLeftColor: HAIRLINE,
        paddingLeft: divider ? 13 : 0,
      }}
    >
      <Text
        className="text-slate dark:text-white/70"
        style={{ fontSize: 18, fontWeight: "800", letterSpacing: -0.4, fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
      <Text className="text-muted dark:text-white/50" style={{ fontSize: 9.5, fontWeight: "700", marginTop: 1 }}>
        {label}
      </Text>
    </View>
  );
}

/** Bars scaled to the busiest day; today reads olive, the rest blue. */
function DayChart({ week }: { week: MyWeek }) {
  const max = Math.max(1, ...week.perDay.map((d) => d.count));
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 9, height: 96, marginTop: 12 }}>
      {week.perDay.map((day, i) => (
        <View key={i} style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%", gap: 7 }}>
          <Text
            className="text-muted dark:text-white/50"
            style={{ fontSize: 9, fontWeight: "700", fontVariant: ["tabular-nums"] }}
          >
            {day.count > 0 ? day.count : ""}
          </Text>
          <View
            style={{
              width: "100%",
              // A zero day keeps a hairline so the column still reads as a day
              // rather than disappearing from the week.
              height: Math.max(2, (day.count / max) * 60),
              borderRadius: 5,
              backgroundColor: day.isToday ? OLIVE : "rgba(37,99,180,0.32)",
            }}
          />
          <Text
            style={{
              fontSize: 9.5,
              fontWeight: day.isToday ? "800" : "700",
              color: day.isToday ? OLIVE_TEXT : MUTED,
            }}
          >
            {day.label}
          </Text>
        </View>
      ))}
    </View>
  );
}
