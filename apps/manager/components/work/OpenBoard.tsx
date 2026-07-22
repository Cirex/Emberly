import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { BandHeader, Chip } from "@/components/work/primitives";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { InitialsBadge } from "@/components/ui/InitialsBadge";
import type { OpenBoard as OpenBoardData, OpenRow } from "@/lib/derived/work-boards";
import { HAIRLINE, MUTED, NAVY } from "@/theme/tokens";

/**
 * Open work orders, banded by priority (Emergency first). Read-only: a row
 * opens the detail sheet, and nothing on this board closes or edits a ticket —
 * that stays in the maintenance app.
 */

function OpenRowView({ row, onPress, last }: { row: OpenRow; onPress: () => void; last: boolean }) {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.unitNumber || t("work.open.noUnit")} · ${row.title}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: HAIRLINE,
      }}
    >
      <View style={{ width: 52 }}>
        <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "800", color: NAVY }}>
          {row.unitNumber || "—"}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 9.5, color: MUTED, marginTop: 1 }}>
          {t("work.days", { count: row.ageDays })}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 12.5, fontWeight: "700", color: NAVY }}>
          {row.title || "—"}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 10.5, color: MUTED }}>
            {row.category || row.status}
          </Text>
          {row.isCallback ? <Chip label={t("work.open.callback")} tone="callback" /> : null}
        </View>
      </View>
      <InitialsBadge name={row.technicianDisplay} size={26} />
    </Pressable>
  );
}

export function OpenBoard({
  board,
  onOpenRow,
}: {
  board: OpenBoardData;
  onOpenRow: (id: string) => void;
}) {
  const { t } = useTranslation();

  if (board.bands.length === 0) {
    return (
      <AppCardSurface kind="panel" style={{ padding: 26, alignItems: "center" }}>
        <Text style={{ fontSize: 12, color: MUTED, textAlign: "center" }}>{t("work.open.empty")}</Text>
      </AppCardSurface>
    );
  }

  return (
    <View>
      {board.bands.map((band) => (
        <View key={band.priority}>
          <BandHeader
            label={t("work.open.band", {
              priority: t(`work.priority.${band.priority}`, band.priority),
              count: band.rows.length,
            })}
            hot={band.priority === "Emergency"}
          />
          <AppCardSurface kind="panel" style={{ paddingVertical: 2 }}>
            {band.rows.map((row, i) => (
              <OpenRowView
                key={row.id}
                row={row}
                onPress={() => onOpenRow(row.id)}
                last={i === band.rows.length - 1}
              />
            ))}
          </AppCardSurface>
        </View>
      ))}
    </View>
  );
}
