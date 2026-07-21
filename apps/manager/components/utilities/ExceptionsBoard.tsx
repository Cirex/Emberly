import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { BandHeader, Chip, StatusPill } from "@/components/utilities/primitives";
import type { UnitExceptionGroup, UtilityException } from "@/lib/derived/utility-exceptions";
import { formatMoney, formatMoneyWhole } from "@/lib/derived/utility-format";
import { HAIRLINE_SOFT, MUTED, NAVY } from "@/theme/tokens";

/**
 * Exceptions mode: the mark-as-reviewed audit queue (mockup "iPhone ·
 * Exceptions"), grouped per unit/house account with the flagged dollar total
 * in each band. "Show reviewed" folds the already-cleared rows back in with an
 * Undo affordance; reviews persist per bill × kind on the server.
 */
export function ExceptionsBoard({
  openGroups,
  allGroups,
  onToggleReview,
}: {
  /** Groups with only open items (the working queue). */
  openGroups: UnitExceptionGroup[];
  /** Groups including reviewed items, for the "Show reviewed" toggle. */
  allGroups: UnitExceptionGroup[];
  onToggleReview: (exception: UtilityException, reviewed: boolean) => void;
}) {
  const { t } = useTranslation();
  const [showReviewed, setShowReviewed] = useState(false);
  const groups = showReviewed ? allGroups : openGroups;

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row" }}>
        <Chip
          label={t("utilities.exceptions.showReviewed")}
          selected={showReviewed}
          onPress={() => setShowReviewed((v) => !v)}
        />
      </View>

      {groups.length === 0 ? (
        <AppCardSurface kind="panel" style={{ padding: 18, alignItems: "center", gap: 6 }}>
          <Ionicons name="checkmark-circle-outline" size={22} color="#33A666" />
          <Text style={{ fontSize: 12, color: MUTED }}>{t("utilities.exceptions.empty")}</Text>
        </AppCardSurface>
      ) : (
        <AppCardSurface kind="panel" style={{ paddingBottom: 6 }}>
          {groups.map((group) => (
            <View key={group.groupKey}>
              <BandHeader
                hot={group.openTotal > 0}
                text={
                  group.isHouseAccount
                    ? t("utilities.exceptions.houseBand", {
                        amount: formatMoneyWhole(group.openTotal),
                      })
                    : t("utilities.exceptions.unitBand", {
                        unit: group.unitNumber,
                        amount: formatMoneyWhole(group.openTotal),
                      })
                }
              />
              {group.items
                .filter((e) => showReviewed || !e.reviewed)
                .map((e) => (
                  <View
                    key={e.reviewedKey}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 9,
                      paddingHorizontal: 16,
                      paddingVertical: 10,
                      borderTopWidth: 1,
                      borderTopColor: HAIRLINE_SOFT,
                      opacity: e.reviewed ? 0.55 : 1,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13.5, fontWeight: "800", color: NAVY }}>
                        {e.title}
                      </Text>
                      <Text style={{ fontSize: 10, fontWeight: "600", color: MUTED, marginTop: 1 }}>
                        {e.detail}
                        {" · "}
                        {e.action}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: "800",
                          fontVariant: ["tabular-nums"],
                          color: e.priority <= 2 ? "#D1382E" : "#B05E14",
                        }}
                      >
                        {formatMoney(e.amount)}
                      </Text>
                      {e.reviewed ? (
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                          <StatusPill tone="neutral" label={t("utilities.exceptions.reviewedTag")} />
                          <Pressable
                            onPress={() => onToggleReview(e, false)}
                            accessibilityRole="button"
                            hitSlop={6}
                          >
                            <Text style={{ fontSize: 10, fontWeight: "800", color: "#7A6BC7" }}>
                              {t("utilities.exceptions.undo")}
                            </Text>
                          </Pressable>
                        </View>
                      ) : (
                        <StatusPill
                          tone="ok"
                          label={t("utilities.exceptions.markReviewed")}
                          onPress={() => onToggleReview(e, true)}
                        />
                      )}
                    </View>
                  </View>
                ))}
            </View>
          ))}
        </AppCardSurface>
      )}
      <Text style={{ fontSize: 10, color: MUTED, textAlign: "center" }}>
        {t("utilities.exceptions.footer")}
      </Text>
    </View>
  );
}
