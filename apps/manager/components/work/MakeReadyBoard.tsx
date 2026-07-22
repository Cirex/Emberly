import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { Chip, StageBar } from "@/components/work/primitives";
import type { MakeReadyBoard as MakeReadyBoardData, MakeReadyRow } from "@/lib/derived/work-boards";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE, MUTED, NAVY } from "@/theme/tokens";

/**
 * The six-stage turn board: one row per unit being turned, ordered by the
 * engine (soonest move-in first, undated last). Read-only — the manager sees
 * where each turn stands and what is stuck, and the crew closes stages in the
 * maintenance app.
 */

/** Move-in urgency → the chip the row shows, or null for the calm brackets. */
function urgencyChip(
  row: MakeReadyRow,
  nowMs: number,
  t: (key: string, params?: Record<string, unknown>) => string,
): { label: string; tone: "emergency" | "high" } | null {
  if (!row.showsUrgency) return null;
  if (row.urgency === "overdue") return { label: t("work.urgency.overdue"), tone: "emergency" };
  if (row.urgency === "today") return { label: t("work.urgency.today"), tone: "emergency" };
  const days = row.moveInAt === null ? 0 : Math.max(0, Math.round((row.moveInAt - nowMs) / 86_400_000));
  return { label: t("work.urgency.nextSevenDays", { count: days }), tone: "high" };
}

function MakeReadyRowView({ row, nowMs, last }: { row: MakeReadyRow; nowMs: number; last: boolean }) {
  const { t } = useTranslation();
  const urgency = urgencyChip(row, nowMs, t);
  const blocked = row.blockedStages;

  return (
    <View
      style={{
        gap: 7,
        paddingHorizontal: 14,
        paddingVertical: 11,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: HAIRLINE,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "800", color: NAVY }}>
          {row.unitNumber}
        </Text>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 10.5, color: MUTED }}>
          {row.moveInAt === null
            ? t("work.makeReady.noMoveIn")
            : t("work.makeReady.moveIn", {
                date: new Date(row.moveInAt).toLocaleDateString(activeLocale(), {
                  month: "short",
                  day: "numeric",
                }),
              })}
        </Text>
        {row.isReady || row.isComplete ? (
          <Chip label={row.isReady ? t("work.makeReady.ready") : t("work.makeReady.complete")} tone="ready" />
        ) : urgency ? (
          <Chip label={urgency.label} tone={urgency.tone} />
        ) : null}
      </View>

      <StageBar total={row.totalStages} done={row.completedStages} blocked={blocked.length} />

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <Text style={{ fontSize: 10.5, color: MUTED }}>
          {t("work.makeReady.progress", { done: row.completedStages, total: row.totalStages })}
          {row.currentStage ? ` · ${t(`work.stages.${row.currentStage}`)}` : ""}
        </Text>
        {blocked.slice(0, 2).map((stage) => (
          <Chip key={stage} label={t("work.makeReady.blocked", { stage: t(`work.stages.${stage}`) })} tone="blocked" />
        ))}
        {blocked.length > 2 ? (
          <Chip label={t("work.makeReady.blockedMore", { count: blocked.length - 2 })} tone="blocked" />
        ) : null}
      </View>
    </View>
  );
}

export function MakeReadyBoard({ board, nowMs }: { board: MakeReadyBoardData; nowMs: number }) {
  const { t } = useTranslation();

  if (board.rows.length === 0) {
    return (
      <AppCardSurface kind="panel" style={{ padding: 26, alignItems: "center" }}>
        <Text style={{ fontSize: 12, color: MUTED, textAlign: "center" }}>{t("work.makeReady.empty")}</Text>
      </AppCardSurface>
    );
  }

  return (
    <AppCardSurface kind="panel" style={{ paddingVertical: 2 }}>
      {board.rows.map((row, i) => (
        <MakeReadyRowView
          key={row.unitNumber}
          row={row}
          nowMs={nowMs}
          last={i === board.rows.length - 1}
        />
      ))}
    </AppCardSurface>
  );
}
