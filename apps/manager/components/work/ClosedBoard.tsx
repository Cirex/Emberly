import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { InitialsBadge } from "@/components/ui/InitialsBadge";
import { Chip } from "@/components/work/primitives";
import type { ClosedBoard as ClosedBoardData, ClosedRow } from "@/lib/derived/work-boards";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE, MUTED, NAVY } from "@/theme/tokens";

/** Recently closed work, newest first. Make-ready turns live on their own board. */

function ClosedRowView({ row, onPress, last }: { row: ClosedRow; onPress: () => void; last: boolean }) {
  const { t } = useTranslation();
  const closedLabel =
    row.completedAt === null
      ? "—"
      : new Date(row.completedAt).toLocaleDateString(activeLocale(), { month: "short", day: "numeric" });
  const duration =
    row.daysToClose === null
      ? null
      : row.daysToClose === 0
        ? t("work.closed.sameDay")
        : t("work.closed.inDays", { count: row.daysToClose });

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
          {closedLabel}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 12.5, fontWeight: "700", color: NAVY }}>
          {row.title || "—"}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 10.5, color: MUTED }}>
            {[row.category || row.status, duration].filter(Boolean).join(" · ")}
          </Text>
          {row.isCallback ? <Chip label={t("work.open.callback")} tone="callback" /> : null}
        </View>
      </View>
      <InitialsBadge name={row.technicianDisplay} size={26} />
    </Pressable>
  );
}

export function ClosedBoard({
  board,
  onOpenRow,
}: {
  board: ClosedBoardData;
  onOpenRow: (id: string) => void;
}) {
  const { t } = useTranslation();

  if (board.rows.length === 0) {
    return (
      <AppCardSurface kind="panel" style={{ padding: 26, alignItems: "center" }}>
        <Text style={{ fontSize: 12, color: MUTED, textAlign: "center" }}>{t("work.closed.empty")}</Text>
      </AppCardSurface>
    );
  }

  return (
    <AppCardSurface kind="panel" style={{ paddingVertical: 2 }}>
      {board.rows.map((row, i) => (
        <ClosedRowView
          key={row.id}
          row={row}
          onPress={() => onOpenRow(row.id)}
          last={i === board.rows.length - 1}
        />
      ))}
    </AppCardSurface>
  );
}
