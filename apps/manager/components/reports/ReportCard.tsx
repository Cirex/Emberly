import { useTranslation } from "react-i18next";
import { Linking, Pressable, Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { capture } from "@/lib/analytics";
import type { OwnerReport } from "@/lib/api/reports";
import { reportHeadlineParts, reportMonthName } from "@/lib/derived/reports";
import { activeLocale } from "@/lib/i18n";
import { useConfig } from "@/lib/stores/config";
import { MUTED, OLIVE_GLASS } from "@/theme/tokens";

/**
 * The Today board's "「Month」 report is ready" card (mockup: iPhone · report
 * ready): olive-tinted card border, headline sentence from the archive
 * entry's frozen summary, one document action.
 *
 * DOCUMENT ACTION — deliberately a single "Open in admin portal" button, not
 * the mockup's Share PDF / View pair: previewing or sharing the PDF on-device
 * needs a file-system + share-sheet module (expo-file-system / expo-sharing)
 * that apps/manager does not ship, and RN core alone cannot spool fetched
 * bytes to a shareable file. Rather than add native dependencies, the action
 * opens the admin portal's archive (the mockup's own footer: "Archive lives
 * in the admin portal too"). When those modules land, restore the two-button
 * row here and fire `report_shared` from the share path.
 */

/** Where the admin portal keeps the report archive (relative to baseUrl). */
export const ADMIN_REPORTS_PATH = "/admin/reports";

/** Open the portal archive at a period and log the view. */
export function openReportInPortal(baseUrl: string, period: string): void {
  capture("report_viewed", { period });
  void Linking.openURL(`${baseUrl}${ADMIN_REPORTS_PATH}?period=${period}`).catch(() => {
    // A browser refusing the URL is not actionable here; the card stays.
  });
}

export function ReportCard({ report }: { report: OwnerReport }) {
  const { t } = useTranslation();
  const baseUrl = useConfig((s) => s.baseUrl);
  const month = reportMonthName(report.period, activeLocale());
  const headline = reportHeadlineParts(report.summary)
    .map((part) => t(`reports.card.headline.${part.key}`, part.params))
    .join(" · ");
  const open = () => openReportInPortal(baseUrl, report.period);

  return (
    <AppCardSurface
      kind="panel"
      style={{
        paddingHorizontal: 16,
        paddingVertical: 13,
        borderColor: "rgba(162,169,33,0.4)",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text
          className="text-navy dark:text-white"
          style={{ fontSize: 13, fontWeight: "800", letterSpacing: -0.2 }}
        >
          {t("reports.card.title", { month })}
        </Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={open} accessibilityRole="button" hitSlop={8}>
          <Text style={{ fontSize: 11, fontWeight: "800", color: OLIVE_GLASS }}>
            {t("reports.card.open")} ›
          </Text>
        </Pressable>
      </View>
      {headline.length > 0 ? (
        <Text
          className="text-muted dark:text-white/60"
          style={{ fontSize: 10.5, lineHeight: 16, marginTop: 6, color: MUTED }}
        >
          {headline}
        </Text>
      ) : null}
      <Pressable
        onPress={open}
        accessibilityRole="button"
        style={{
          marginTop: 10,
          borderRadius: 12,
          paddingVertical: 9,
          alignItems: "center",
          backgroundColor: "rgba(162,169,33,0.92)",
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "800", color: "#FFFFFF" }}>
          {t("reports.card.openPortal")}
        </Text>
      </Pressable>
    </AppCardSurface>
  );
}
