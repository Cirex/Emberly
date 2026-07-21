import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import type { AgentStat } from "@emberly/core";
import { ListFooter, MeterBar, MONEY_COLORS, Pill } from "@/components/delinquency/bits";
import { fmtMoneyCompact, fmtPercent } from "@/components/delinquency/format";

/**
 * Full-scale ratios for the scorecard meters: the rate at which the bar
 * renders 100% wide. Chosen so a healthy book sits under a third of the
 * track and a problem book visibly pins it (10% evictions IS maxed out).
 */
const METER_SCALE = { evictionRate: 0.1, delinquencyLoad: 0.15, earlyDefaultRate: 0.125 } as const;

/** The tint flips red at half of full-scale — see MeterBar's dangerAt. */
const DANGER_AT = 0.5;

function Meter({ label, display, ratio }: { label: string; display: string; ratio: number }) {
  const pinned = Math.min(1, ratio);
  return (
    <View style={{ flex: 1, minWidth: 120 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 3 }}>
        <Text style={{ fontSize: 8.5, fontWeight: "700", color: MONEY_COLORS.muted }}>{label}</Text>
        <Text
          style={{
            fontSize: 8.5,
            fontWeight: "800",
            fontVariant: ["tabular-nums"],
            color: pinned >= DANGER_AT ? MONEY_COLORS.bad : MONEY_COLORS.navy,
          }}
        >
          {display}
        </Text>
      </View>
      <MeterBar ratio={pinned} dangerAt={DANGER_AT} />
    </View>
  );
}

function AgentCard({
  stat,
  rank,
  selected,
  onPress,
}: {
  stat: AgentStat;
  rank: number;
  selected: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const risky = stat.evictionRate >= METER_SCALE.evictionRate * DANGER_AT;
  const best = rank === 1 && !stat.lowVolume && !risky;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{
        marginHorizontal: 14,
        marginVertical: 5,
        backgroundColor: "#FFFFFF",
        borderWidth: 1,
        borderColor: selected
          ? "rgba(162,169,33,0.88)"
          : risky && !stat.lowVolume
            ? "rgba(209,56,46,0.3)"
            : "rgba(9,27,84,0.08)",
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 12,
        opacity: stat.lowVolume ? 0.75 : 1,
        shadowColor: MONEY_COLORS.navy,
        shadowOpacity: 0.05,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 4 },
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: best
              ? "rgba(51,166,102,0.12)"
              : risky && !stat.lowVolume
                ? "rgba(209,56,46,0.1)"
                : "rgba(9,27,84,0.05)",
          }}
        >
          <Text
            style={{
              fontSize: 10,
              fontWeight: "800",
              color: best ? MONEY_COLORS.pos : risky && !stat.lowVolume ? MONEY_COLORS.bad : MONEY_COLORS.slate,
            }}
          >
            {stat.lowVolume ? "—" : String(rank)}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "800", color: MONEY_COLORS.navy }}>
            {stat.agent}
          </Text>
          <Text style={{ fontSize: 9, color: MONEY_COLORS.muted }}>
            {t("delinquency.agents.leasesActive", { signed: stat.leasesSigned, active: stat.active })}
          </Text>
        </View>
        {stat.lowVolume ? <Pill tone="neutral" label={t("delinquency.agents.lowVolume")} /> : null}
      </View>

      {stat.lowVolume ? null : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 9 }}>
          <Meter
            label={t("delinquency.agents.evictionRate")}
            display={`${fmtPercent(stat.evictionRate)} · ${stat.evictions}`}
            ratio={stat.evictionRate / METER_SCALE.evictionRate}
          />
          <Meter
            label={t("delinquency.agents.delinquencyLoad")}
            display={`${fmtPercent(stat.delinquencyLoad)} · ${fmtMoneyCompact(stat.delinquentBalance)}`}
            ratio={stat.delinquencyLoad / METER_SCALE.delinquencyLoad}
          />
          <Meter
            label={t("delinquency.agents.earlyDefault")}
            display={fmtPercent(stat.earlyDefaultRate)}
            ratio={stat.earlyDefaultRate / METER_SCALE.earlyDefaultRate}
          />
        </View>
      )}
    </Pressable>
  );
}

/**
 * Agents mode body: ranked scorecards (core's buildAgentStats order — best
 * book first). Low-volume books render dimmed with a badge instead of a rank
 * and no meters; small numbers are anecdotes, not patterns.
 */
export function AgentsList({
  stats,
  selectedAgent,
  onSelect,
}: {
  stats: AgentStat[];
  selectedAgent: string | null;
  onSelect: (stat: AgentStat) => void;
}) {
  const { t } = useTranslation();
  // Ranks count only ranked (non-low-volume) books.
  const ranked = useMemo(
    () =>
      stats.map((stat, i) => ({
        stat,
        rank: stats.slice(0, i + 1).filter((s) => !s.lowVolume).length,
      })),
    [stats],
  );
  return (
    <View style={{ paddingTop: 8 }}>
      {ranked.length === 0 ? (
        <ListFooter>{t("delinquency.empty.agents")}</ListFooter>
      ) : (
        <>
          {ranked.map(({ stat, rank }) => (
            <AgentCard
              key={stat.agent}
              stat={stat}
              rank={rank}
              selected={stat.agent === selectedAgent}
              onPress={() => onSelect(stat)}
            />
          ))}
          <ListFooter>{t("delinquency.footer.agents")}</ListFooter>
        </>
      )}
    </View>
  );
}
