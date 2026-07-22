import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { openReportInPortal } from "@/components/reports/ReportCard";
import type { OwnerReport } from "@/lib/api/reports";
import { pastReportStats, reportMonthYearLabel } from "@/lib/derived/reports";
import { activeLocale } from "@/lib/i18n";
import { useConfig } from "@/lib/stores/config";
import { HAIRLINE, MUTED } from "@/theme/tokens";

/**
 * The Today board's PAST REPORTS band (mockup: iPhone · report ready, lower
 * half): uppercased band label, then one row per archived period — month +
 * two summary stats from the frozen figures, "PDF ›" on the right. Tapping a
 * row opens that period in the admin portal archive (see ReportCard.tsx for
 * why the portal, not an on-device viewer) and logs `report_viewed`.
 *
 * Renders nothing while the archive has no past periods — same
 * hide-until-data behavior as the other cross-feature Today cards.
 */
export function PastReports({ reports }: { reports: OwnerReport[] }) {
  const { t } = useTranslation();
  const baseUrl = useConfig((s) => s.baseUrl);
  if (reports.length === 0) return null;

  return (
    <View>
      <Text
        style={{
          fontSize: 10,
          fontWeight: "800",
          letterSpacing: 0.8,
          textTransform: "uppercase",
          color: MUTED,
          paddingHorizontal: 4,
          paddingBottom: 7,
        }}
      >
        {t("reports.past.band")}
      </Text>
      <AppCardSurface kind="panel" style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
        {reports.map((report, index) => {
          const stats = pastReportStats(report.summary)
            .map((stat) => t(`reports.past.stats.${stat.key}`, { value: stat.value }))
            .join(" · ");
          return (
            <Pressable
              key={report.period}
              accessibilityRole="button"
              onPress={() => openReportInPortal(baseUrl, report.period)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
                paddingVertical: 10,
                borderBottomWidth: index === reports.length - 1 ? 0 : 1,
                borderBottomColor: HAIRLINE,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  className="text-navy dark:text-white"
                  style={{ fontSize: 12, fontWeight: "800" }}
                >
                  {reportMonthYearLabel(report.period, activeLocale())}
                </Text>
                {stats.length > 0 ? (
                  <Text style={{ fontSize: 9.5, fontWeight: "600", color: MUTED, marginTop: 1 }}>
                    {stats}
                  </Text>
                ) : null}
              </View>
              <Text style={{ fontSize: 10.5, fontWeight: "700", color: MUTED }}>
                {t("reports.past.pdf")} ›
              </Text>
            </Pressable>
          );
        })}
      </AppCardSurface>
      <Text
        style={{
          fontSize: 10,
          color: MUTED,
          textAlign: "center",
          paddingTop: 8,
        }}
      >
        {t("reports.footer")}
      </Text>
    </View>
  );
}
