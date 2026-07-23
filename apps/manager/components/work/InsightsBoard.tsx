import { useTranslation } from "react-i18next";
import { Text, View, useWindowDimensions } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { InitialsBadge } from "@/components/ui/InitialsBadge";
import { HAIRLINE, HAIRLINE_SOFT, MUTED, NAVY } from "@/theme/tokens";
import type { LabeledCount, TechWorkload, WorkInsights } from "@/lib/derived/work-insights";

/**
 * Work · Insights board (mockup frame 05). Read-only distributions over the
 * work-order mirror: category mix, weekly close cadence, open-age buckets,
 * per-technician workload, and the hot-spots ranking. The five scorecards ride
 * the shared BoardHeader strip; this renders the cards beneath.
 */

const CATEGORY_COLORS = ["#458ADB", "#D1382E", "#E38736", "#A2A921", "#7A6BC7", "#70788F"];
const AGE_COLORS = ["#33A666", "#A2A921", "#E38736", "#D1382E"];
const BAR_BLUE = "#458ADB";

function CardTitle({ title, caption }: { title: string; caption?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
      <Text style={{ fontSize: 13, fontWeight: "800", letterSpacing: -0.2, color: NAVY }}>{title}</Text>
      {caption ? <Text style={{ fontSize: 10.5, color: MUTED }}>{caption}</Text> : null}
    </View>
  );
}

function HBarRow({
  label,
  count,
  max,
  color,
  leading,
  trailing,
}: {
  label: string;
  count: number;
  max: number;
  color: string;
  /** Optional element before the label (a tech badge). */
  leading?: React.ReactNode;
  /** Optional muted text after the count (median · closed). */
  trailing?: string;
}) {
  const pct = max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
      {leading}
      <Text numberOfLines={1} style={{ width: leading ? 68 : 92, fontSize: 11, fontWeight: "600", color: NAVY }}>
        {label}
      </Text>
      <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: HAIRLINE_SOFT, overflow: "hidden" }}>
        <View style={{ width: `${pct}%`, height: "100%", borderRadius: 4, backgroundColor: color }} />
      </View>
      <Text style={{ width: 26, textAlign: "right", fontSize: 11.5, fontWeight: "800", color: NAVY, fontVariant: ["tabular-nums"] }}>
        {count}
      </Text>
      {trailing ? (
        <Text style={{ width: 78, fontSize: 9.5, color: MUTED, fontVariant: ["tabular-nums"] }}>{trailing}</Text>
      ) : null}
    </View>
  );
}

/** A row of value bars, last one emphasized (close cadence / signals). */
function WeekSpark({ values, height = 60 }: { values: number[]; height?: number }) {
  const max = Math.max(1, ...values);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 3, height }}>
      {values.map((v, i) => (
        <View
          key={i}
          style={{
            flex: 1,
            height: `${Math.max(6, Math.round((v / max) * 100))}%`,
            borderRadius: 2,
            backgroundColor: i === values.length - 1 ? "#848F0D" : "rgba(37,99,180,0.35)",
          }}
        />
      ))}
    </View>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: object }) {
  return (
    <AppCardSurface kind="panel" style={{ paddingHorizontal: 16, paddingVertical: 14, ...style }}>
      {children}
    </AppCardSurface>
  );
}

function CategoryCard({ categories }: { categories: LabeledCount[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...categories.map((c) => c.count));
  return (
    <Card>
      <CardTitle title={t("work.insights.categories")} caption={t("work.insights.categoriesCaption")} />
      {categories.map((c, i) => (
        <HBarRow key={c.label} label={c.label} count={c.count} max={max} color={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
      ))}
    </Card>
  );
}

function ClosesAgeCard({ insights }: { insights: WorkInsights }) {
  const { t } = useTranslation();
  const ageMax = Math.max(1, ...insights.ageBuckets.map((b) => b.count));
  return (
    <Card>
      <CardTitle title={t("work.insights.closesPerWeek")} caption={t("work.insights.weeks12")} />
      <WeekSpark values={insights.closesPerWeek} />
      <View style={{ marginTop: 14 }}>
        <CardTitle title={t("work.insights.ageOfOpen")} />
        {insights.ageBuckets.map((b, i) => (
          <HBarRow key={b.label} label={b.label} count={b.count} max={ageMax} color={AGE_COLORS[i]} />
        ))}
      </View>
    </Card>
  );
}

function TechCard({ techWorkload }: { techWorkload: TechWorkload[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...techWorkload.map((tw) => tw.openCount));
  return (
    <Card>
      <CardTitle title={t("work.insights.techWorkload")} caption={t("work.insights.techWorkloadCaption")} />
      {techWorkload.map((tw) => (
        <HBarRow
          key={tw.tech}
          leading={<InitialsBadge name={tw.tech === "Unassigned" ? "?" : tw.tech} size={24} />}
          label={tw.tech}
          count={tw.openCount}
          max={max}
          color={tw.unassigned ? "#D1382E" : BAR_BLUE}
          trailing={
            tw.unassigned
              ? t("work.insights.assignNow")
              : `${tw.medianCloseDays === null ? "—" : `${tw.medianCloseDays.toFixed(1)}d`} · ${tw.closed30} ${t("work.insights.closedShort")}`
          }
        />
      ))}
    </Card>
  );
}

function HotSpotsCard({ insights }: { insights: WorkInsights }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardTitle title={t("work.insights.hotSpots")} caption={t("work.insights.signalsPerWeek")} />
      <WeekSpark values={insights.signalsPerWeek} height={44} />
      <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: HAIRLINE_SOFT }}>
        {insights.hotSpots.length === 0 ? (
          <Text style={{ fontSize: 11, color: MUTED, paddingTop: 10 }}>{t("work.insights.noHotSpots")}</Text>
        ) : (
          insights.hotSpots.map((h, i) => (
            <View
              key={h.unitNumber}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingVertical: 7,
                borderBottomWidth: i === insights.hotSpots.length - 1 ? 0 : 1,
                borderBottomColor: HAIRLINE,
              }}
            >
              <Text style={{ width: 74, fontSize: 12, fontWeight: "800", color: NAVY, fontVariant: ["tabular-nums"] }}>
                {h.unitNumber}
              </Text>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 10.5, color: MUTED }}>
                {t("work.insights.hotSpotMeta", { orders: h.orders, callbacks: h.callbacks })}
              </Text>
              <Text style={{ fontSize: 11, fontWeight: "800", color: h.rank <= 2 ? "#D1382E" : "#B05E14" }}>
                {t("work.insights.risk", { rank: h.rank })}
              </Text>
            </View>
          ))
        )}
      </View>
      <Text style={{ fontSize: 9.5, color: MUTED, marginTop: 10 }}>{t("work.insights.hotSpotsNote")}</Text>
    </Card>
  );
}

export function InsightsBoard({ insights }: { insights: WorkInsights }) {
  const { width } = useWindowDimensions();
  const wide = width >= 1040;

  if (wide) {
    return (
      <View style={{ flexDirection: "row", gap: 14, alignItems: "flex-start" }}>
        <View style={{ flex: 1, gap: 14 }}>
          <CategoryCard categories={insights.categories} />
          <TechCard techWorkload={insights.techWorkload} />
        </View>
        <View style={{ flex: 1, gap: 14 }}>
          <ClosesAgeCard insights={insights} />
          <HotSpotsCard insights={insights} />
        </View>
      </View>
    );
  }
  return (
    <View style={{ gap: 14 }}>
      <CategoryCard categories={insights.categories} />
      <ClosesAgeCard insights={insights} />
      <TechCard techWorkload={insights.techWorkload} />
      <HotSpotsCard insights={insights} />
    </View>
  );
}
