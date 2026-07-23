import { Ionicons } from "@expo/vector-icons";
import { MAKE_READY_STAGES, type MakeReadyStage } from "@emberly/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { InitialsBadge } from "@/components/ui/InitialsBadge";
import { BandHeader, Chip, StageBar } from "@/components/work/primitives";
import type { MakeReadyBoard as MakeReadyBoardData, MakeReadyRow, OpenUnitGroup } from "@/lib/derived/work-boards";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE_SOFT, MUTED, NAVY, OLIVE } from "@/theme/tokens";

/**
 * The six-stage turn board (mockup frame 06). Turns band into Move-in at risk /
 * Scheduled / Ready; on tablet, selecting a turn opens its stage checklist and
 * the unit's linked work orders. Read-only — the crew closes stages in the
 * maintenance app.
 */

type BandKey = "atRisk" | "scheduled" | "ready";

function bandOf(row: MakeReadyRow): BandKey {
  if (row.isReady || row.isComplete) return "ready";
  if (row.showsUrgency) return "atRisk";
  return "scheduled";
}

function moveInLabel(row: MakeReadyRow, t: (k: string, p?: Record<string, unknown>) => string): string {
  return row.moveInAt === null
    ? t("work.makeReady.noMoveIn")
    : t("work.makeReady.moveIn", {
        date: new Date(row.moveInAt).toLocaleDateString(activeLocale(), { month: "short", day: "numeric" }),
      });
}

function urgencyChip(
  row: MakeReadyRow,
  nowMs: number,
  t: (k: string, p?: Record<string, unknown>) => string,
): { label: string; tone: "emergency" | "high" | "ready" } | null {
  if (row.isReady || row.isComplete) return { label: t("work.makeReady.ready"), tone: "ready" };
  if (!row.showsUrgency) return null;
  if (row.urgency === "overdue") return { label: t("work.urgency.overdue"), tone: "emergency" };
  if (row.urgency === "today") return { label: t("work.urgency.today"), tone: "emergency" };
  const days = row.moveInAt === null ? 0 : Math.max(0, Math.round((row.moveInAt - nowMs) / 86_400_000));
  return { label: t("work.urgency.nextSevenDays", { count: days }), tone: "high" };
}

/** Per-stage status derived from the row's counts. */
type StageState = "done" | "blocked" | "current" | "pending";
function stageState(row: MakeReadyRow, stage: MakeReadyStage, index: number): StageState {
  if (index < row.completedStages) return "done";
  if (row.blockedStages.includes(stage)) return "blocked";
  if (row.currentStage === stage) return "current";
  return "pending";
}

function TurnRow({
  row,
  nowMs,
  selected,
  onPress,
}: {
  row: MakeReadyRow;
  nowMs: number;
  selected: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const chip = urgencyChip(row, nowMs, t);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{
        gap: 7,
        paddingHorizontal: 14,
        paddingVertical: 11,
        backgroundColor: selected ? "rgba(162,169,33,0.10)" : "transparent",
        borderLeftWidth: selected ? 3 : 0,
        borderLeftColor: OLIVE,
        borderBottomWidth: 1,
        borderBottomColor: HAIRLINE_SOFT,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "800", color: NAVY }}>
          {row.unitNumber}
        </Text>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 10.5, color: MUTED }}>
          {moveInLabel(row, t)}
        </Text>
        {chip ? <Chip label={chip.label} tone={chip.tone} /> : null}
      </View>
      <StageBar total={row.totalStages} done={row.completedStages} blocked={row.blockedStages.length} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <Text style={{ fontSize: 10.5, color: MUTED }}>
          {t("work.makeReady.progress", { done: row.completedStages, total: row.totalStages })}
          {row.currentStage ? ` · ${t(`work.stages.${row.currentStage}`)}` : ""}
        </Text>
        {row.blockedStages.slice(0, 2).map((stage) => (
          <Chip key={stage} label={t("work.makeReady.blocked", { stage: t(`work.stages.${stage}`) })} tone="blocked" />
        ))}
      </View>
    </Pressable>
  );
}

function StageCheck({ label, state, note, last }: { label: string; state: StageState; note: string; last: boolean }) {
  const ring =
    state === "done"
      ? { bg: "#1F7A47", border: "#1F7A47" }
      : state === "blocked"
        ? { bg: "#D1382E", border: "#D1382E" }
        : state === "current"
          ? { bg: "transparent", border: "#2563B4" }
          : { bg: "transparent", border: "rgba(9,27,84,0.22)" };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 7,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: HAIRLINE_SOFT,
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          borderWidth: 2,
          borderColor: ring.border,
          backgroundColor: ring.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {state === "done" ? <Ionicons name="checkmark" size={11} color="#fff" /> : null}
        {state === "blocked" ? <Ionicons name="close" size={11} color="#fff" /> : null}
      </View>
      <Text style={{ width: 96, fontSize: 12, fontWeight: "700", color: NAVY }}>{label}</Text>
      <Text
        style={{
          flex: 1,
          fontSize: 10.5,
          fontWeight: state === "blocked" ? "800" : "500",
          color: state === "blocked" ? "#D1382E" : MUTED,
        }}
      >
        {note}
      </Text>
    </View>
  );
}

function TurnDetail({
  row,
  nowMs,
  linked,
  onOpenOrder,
}: {
  row: MakeReadyRow;
  nowMs: number;
  linked: OpenUnitGroup | undefined;
  onOpenOrder: (id: string) => void;
}) {
  const { t } = useTranslation();
  const chip = urgencyChip(row, nowMs, t);
  const stageNote = (state: StageState): string =>
    state === "done"
      ? t("work.makeReady.stageDone")
      : state === "blocked"
        ? t("work.makeReady.stageBlocked")
        : state === "current"
          ? t("work.makeReady.stageCurrent")
          : t("work.makeReady.detailNone");

  return (
    <AppCardSurface kind="panel" style={{ paddingHorizontal: 18, paddingVertical: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: "800", letterSpacing: -0.2, color: NAVY }}>
            {t("work.makeReady.turnTitle", { unit: row.unitNumber })}
          </Text>
          <Text style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{moveInLabel(row, t)}</Text>
        </View>
        {chip ? <Chip label={chip.label} tone={chip.tone} /> : null}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 14, gap: 0 }}>
        <Fact label={t("work.makeReady.detailProgress")} value={`${row.completedStages} / ${row.totalStages}`} />
        <Fact
          label={t("work.makeReady.detailCurrent")}
          value={row.currentStage ? t(`work.stages.${row.currentStage}`) : t("work.makeReady.complete")}
        />
        <Fact
          label={t("work.makeReady.detailBlocking")}
          value={
            row.blockedStages.length === 0
              ? t("work.makeReady.detailNone")
              : row.blockedStages.map((s) => t(`work.stages.${s}`)).join(", ")
          }
          danger={row.blockedStages.length > 0}
        />
      </View>

      <Text style={sectionLabel}>{t("work.makeReady.stageChecklist").toUpperCase()}</Text>
      <View style={{ marginTop: 4 }}>
        {MAKE_READY_STAGES.map((stage, i) => {
          const state = stageState(row, stage, i);
          return (
            <StageCheck
              key={stage}
              label={t(`work.stages.${stage}`)}
              state={state}
              note={stageNote(state)}
              last={i === MAKE_READY_STAGES.length - 1}
            />
          );
        })}
      </View>

      <Text style={sectionLabel}>{t("work.makeReady.linkedOrders").toUpperCase()}</Text>
      {linked && linked.lines.length > 0 ? (
        linked.lines.map((line) => (
          <Pressable
            key={line.id}
            onPress={() => onOpenOrder(line.id)}
            accessibilityRole="button"
            style={{ flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 7 }}
          >
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: line.priority === "Emergency" ? "#D1382E" : "#E38736",
              }}
            />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: NAVY }}>
              {line.title || "—"}
            </Text>
            <Text style={{ fontSize: 10, color: MUTED }}>
              {line.category || line.status} · {t("work.days", { count: line.ageDays })}
            </Text>
            <InitialsBadge name={line.technicianDisplay} size={20} />
          </Pressable>
        ))
      ) : (
        <Text style={{ fontSize: 11, color: MUTED, paddingTop: 6 }}>{t("work.makeReady.noLinkedOrders")}</Text>
      )}
    </AppCardSurface>
  );
}

const sectionLabel = {
  marginTop: 16,
  fontSize: 10,
  fontWeight: "800" as const,
  letterSpacing: 0.8,
  color: MUTED,
};

function Fact({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <View style={{ width: "50%", paddingVertical: 5 }}>
      <Text style={{ fontSize: 9.5, fontWeight: "700", letterSpacing: 0.4, color: MUTED, textTransform: "uppercase" }}>
        {label}
      </Text>
      <Text style={{ fontSize: 13, fontWeight: "800", color: danger ? "#D1382E" : NAVY, marginTop: 1 }}>{value}</Text>
    </View>
  );
}

export function MakeReadyBoard({
  board,
  nowMs,
  openGroups,
  onOpenOrder,
}: {
  board: MakeReadyBoardData;
  nowMs: number;
  openGroups: OpenUnitGroup[];
  onOpenOrder: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const wide = width >= 1040;

  const banded = useMemo(() => {
    const g: Record<BandKey, MakeReadyRow[]> = { atRisk: [], scheduled: [], ready: [] };
    for (const row of board.rows) g[bandOf(row)].push(row);
    return g;
  }, [board.rows]);

  const [selectedUnit, setSelectedUnit] = useState<string | null>(null);
  const selected = useMemo(
    () => board.rows.find((r) => r.unitNumber === selectedUnit) ?? null,
    [board.rows, selectedUnit],
  );

  if (board.rows.length === 0) {
    return (
      <AppCardSurface kind="panel" style={{ padding: 26, alignItems: "center" }}>
        <Text style={{ fontSize: 12, color: MUTED, textAlign: "center" }}>{t("work.makeReady.empty")}</Text>
      </AppCardSurface>
    );
  }

  const BANDS: { key: BandKey; label: string; hot: boolean }[] = [
    { key: "atRisk", label: t("work.makeReady.bandAtRisk"), hot: true },
    { key: "scheduled", label: t("work.makeReady.bandScheduled"), hot: false },
    { key: "ready", label: t("work.makeReady.bandReady"), hot: false },
  ];

  const list = (
    <View>
      {BANDS.map(({ key, label, hot }) =>
        banded[key].length === 0 ? null : (
          <View key={key}>
            <BandHeader label={`${label} · ${banded[key].length}`} hot={hot} />
            <AppCardSurface kind="panel" style={{ paddingVertical: 2 }}>
              {banded[key].map((row) => (
                <TurnRow
                  key={row.unitNumber}
                  row={row}
                  nowMs={nowMs}
                  selected={selected?.unitNumber === row.unitNumber}
                  onPress={() => setSelectedUnit(row.unitNumber)}
                />
              ))}
            </AppCardSurface>
          </View>
        ),
      )}
    </View>
  );

  if (!wide) return list;

  return (
    <View style={{ flexDirection: "row", gap: 16, alignItems: "flex-start" }}>
      <View style={{ flex: 1, minWidth: 0 }}>{list}</View>
      <View style={{ width: 380 }}>
        {selected ? (
          <TurnDetail
            row={selected}
            nowMs={nowMs}
            linked={openGroups.find((g) => g.unitNumber === selected.unitNumber)}
            onOpenOrder={onOpenOrder}
          />
        ) : (
          <AppCardSurface kind="panel" style={{ padding: 26, alignItems: "center" }}>
            <Text style={{ fontSize: 12, color: MUTED, textAlign: "center" }}>{t("work.makeReady.selectPrompt")}</Text>
          </AppCardSurface>
        )}
      </View>
    </View>
  );
}
