import { Pressable, Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { ClassificationChip, ColumnHeader, WorkOrderRow } from "@/components/work-orders/rows";
import type { HotSpotRow } from "@/lib/derived/hot-spots";
import type { ParsedWorkOrder } from "@/lib/derived/types";
import { abbreviatedDate } from "@/lib/derived/time";
import { CALLBACK_TINT, HAIRLINE, HAIRLINE_SOFT } from "@/theme/tokens";

/**
 * Hot Spots mode: the repeat-maintenance risk board. Phone shows the ranked
 * unit list, swapping to the detail pane when a unit is selected; tablet shows
 * list and detail side by side (first row auto-selected).
 */

const DETAIL_CAP = 12;

const RISK_TINTS: Record<HotSpotRow["riskLevel"], { fg: string; bg: string }> = {
  High: { fg: "#D1382E", bg: "rgba(209,56,46,0.12)" },
  Watch: { fg: "#B05E14", bg: "rgba(235,133,46,0.13)" },
  Monitor: { fg: "#2563B4", bg: "rgba(61,135,224,0.12)" },
};

function rowSignal(wo: ParsedWorkOrder): "callback" | "duplicate" | null {
  if (wo.callbackStatus === "possible" || wo.callbackStatus === "confirmed") return "callback";
  if (wo.isDuplicate) return "duplicate";
  return null;
}

/** Big score over a tiny uppercase risk label, tinted by risk level. */
function RiskBadge({
  score,
  riskLevel,
  compact = false,
}: {
  score: number;
  riskLevel: HotSpotRow["riskLevel"];
  compact?: boolean;
}) {
  const tint = RISK_TINTS[riskLevel];
  return (
    <View
      style={{
        borderRadius: 13,
        paddingHorizontal: compact ? 9 : 11,
        paddingVertical: compact ? 4 : 6,
        alignItems: "center",
        backgroundColor: tint.bg,
      }}
    >
      <Text
        style={{
          fontSize: compact ? 15 : 18,
          fontWeight: "800",
          fontVariant: ["tabular-nums"],
          color: tint.fg,
        }}
      >
        {score}
      </Text>
      <Text style={{ fontSize: compact ? 7.8 : 8.4, fontWeight: "700", letterSpacing: 0.6, color: tint.fg }}>
        {riskLevel.toUpperCase()}
      </Text>
    </View>
  );
}

/** "<n> tickets · <n> open · <n> callback signal(s) · <n> duplicate(s)". */
function SignalLine({ row }: { row: HotSpotRow }) {
  return (
    <Text className="text-slate dark:text-white/70" numberOfLines={1} style={{ fontSize: 11.3, marginTop: 2 }}>
      {row.totalCount} ticket{row.totalCount === 1 ? "" : "s"}
      {" · "}
      {row.openCount > 0 ? (
        <Text style={{ fontWeight: "600", color: "#D1382E" }}>{row.openCount} open</Text>
      ) : (
        "0 open"
      )}
      {row.callbackCount > 0
        ? ` · ${row.callbackCount} callback signal${row.callbackCount === 1 ? "" : "s"}`
        : ""}
      {row.duplicateCount > 0 ? ` · ${row.duplicateCount} duplicate${row.duplicateCount === 1 ? "" : "s"}` : ""}
    </Text>
  );
}

// ── List ────────────────────────────────────────────────────────────────────

function HotSpotList({
  rows,
  selectedUnit,
  onSelectUnit,
  highlightSelection,
}: {
  rows: HotSpotRow[];
  selectedUnit: string | null;
  onSelectUnit: (u: string | null) => void;
  highlightSelection: boolean;
}) {
  return (
    <AppCardSurface kind="panel" style={{ overflow: "hidden" }}>
      {rows.map((row, i) => {
        const selected = row.unitNumber === selectedUnit;
        return (
          <Pressable
            key={row.unitNumber}
            onPress={() => onSelectUnit(selected ? null : row.unitNumber)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: HAIRLINE_SOFT,
              backgroundColor: highlightSelection && selected ? "rgba(162,169,33,0.10)" : undefined,
            }}
          >
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "700" }}>
                  {row.unitNumber}
                </Text>
                <ClassificationChip classification={row.classification} />
              </View>
              <SignalLine row={row} />
            </View>
            <RiskBadge score={row.score} riskLevel={row.riskLevel} />
          </Pressable>
        );
      })}
    </AppCardSurface>
  );
}

// ── Detail pane ─────────────────────────────────────────────────────────────

function MetricCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View
      style={{
        flexBasis: "30%",
        flexGrow: 1,
        borderRadius: 11,
        borderWidth: 1,
        borderColor: HAIRLINE,
        backgroundColor: "rgba(255,255,255,0.55)",
        padding: 8,
      }}
    >
      <Text
        className="text-muted dark:text-white/50"
        numberOfLines={1}
        style={{ fontSize: 9, fontWeight: "700", letterSpacing: 0.5 }}
      >
        {label}
      </Text>
      <Text
        className={color ? "" : "text-navy dark:text-white"}
        style={{ fontSize: 14, fontWeight: "700", marginTop: 3, fontVariant: ["tabular-nums"], color }}
      >
        {value}
      </Text>
    </View>
  );
}

function DetailPane({ row, nowMs }: { row: HotSpotRow; nowMs: number }) {
  const shown = row.detail.slice(0, DETAIL_CAP);
  const overflow = row.detail.length - shown.length;
  return (
    <AppCardSurface kind="panel" style={{ overflow: "hidden" }}>
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Text className="text-navy dark:text-white" style={{ fontSize: 16, fontWeight: "700" }}>
            {row.unitNumber}
          </Text>
          <ClassificationChip classification={row.classification} />
          <View style={{ flex: 1 }} />
          <RiskBadge score={row.score} riskLevel={row.riskLevel} compact />
        </View>
        <Text className="text-muted dark:text-white/60" style={{ fontSize: 11, marginTop: 2 }}>
          {row.occupiedDaysText ?? row.sinceLabel}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          <MetricCell label="TOTAL TICKETS" value={String(row.totalCount)} />
          <MetricCell label="LAST 90 DAYS" value={String(row.recentCount)} />
          <MetricCell
            label="OPEN NOW"
            value={String(row.openCount)}
            color={row.openCount > 0 ? "#D1382E" : undefined}
          />
          <MetricCell
            label="CALLBACKS"
            value={String(row.callbackCount)}
            color={row.callbackCount > 0 ? CALLBACK_TINT : undefined}
          />
          <MetricCell
            label="DUPLICATES"
            value={String(row.duplicateCount)}
            color={row.duplicateCount > 0 ? "#2563B4" : undefined}
          />
          <MetricCell
            label="OLDEST OPEN"
            value={row.oldestOpenDays !== null ? `${row.oldestOpenDays}d` : "—"}
          />
        </View>
        <Text
          className="text-muted dark:text-white/50"
          style={{ fontSize: 8.5, fontWeight: "700", letterSpacing: 0.7, marginTop: 14 }}
        >
          WORK ORDERS IN LAST 90 DAYS
        </Text>
      </View>
      <ColumnHeader labels={["ID", "Status", "Technician", "Reported"]} />
      {shown.map((wo) => (
        <WorkOrderRow
          key={wo.id}
          number={wo.number}
          status={wo.status}
          title={wo.title}
          signal={rowSignal(wo)}
          middle={
            <Text className="text-muted dark:text-white/60" numberOfLines={1} style={{ fontSize: 10.5 }}>
              {wo.technicianDisplay}
            </Text>
          }
          trailing={abbreviatedDate(wo.reportedAt ?? wo.completedAt, nowMs)}
        />
      ))}
      {overflow > 0 ? (
        <View style={{ borderTopWidth: 1, borderTopColor: HAIRLINE_SOFT, paddingHorizontal: 14, paddingVertical: 8 }}>
          <Text className="text-muted dark:text-white/50" style={{ fontSize: 10.5 }}>
            +{overflow} more
          </Text>
        </View>
      ) : null}
    </AppCardSurface>
  );
}

// ── Board ───────────────────────────────────────────────────────────────────

export function HotSpots({
  rows,
  selectedUnit,
  onSelectUnit,
  nowMs,
  width,
}: {
  rows: HotSpotRow[];
  selectedUnit: string | null;
  onSelectUnit: (u: string | null) => void;
  nowMs: number;
  width: number;
}) {
  const tablet = width >= 768;

  if (rows.length === 0) {
    return (
      <AppCardSurface kind="panel" style={{ paddingVertical: 30, paddingHorizontal: 20, alignItems: "center" }}>
        <Text className="text-navy dark:text-white" style={{ fontSize: 13, fontWeight: "700" }}>
          No unit hot spots
        </Text>
        <Text
          className="text-muted dark:text-white/60"
          style={{ fontSize: 11, marginTop: 4, textAlign: "center" }}
        >
          No units currently show repeat-maintenance signals.
        </Text>
      </AppCardSurface>
    );
  }

  const selectedRow =
    selectedUnit !== null ? (rows.find((r) => r.unitNumber === selectedUnit) ?? null) : null;

  if (!tablet) {
    if (selectedRow) {
      return (
        <View>
          <Pressable
            onPress={() => onSelectUnit(null)}
            accessibilityRole="button"
            hitSlop={8}
            style={{ alignSelf: "flex-start", marginBottom: 8 }}
          >
            <Text style={{ fontSize: 12.5, fontWeight: "600", color: "#4C556F" }}>‹  All hot spots</Text>
          </Pressable>
          <DetailPane row={selectedRow} nowMs={nowMs} />
        </View>
      );
    }
    return (
      <HotSpotList rows={rows} selectedUnit={selectedUnit} onSelectUnit={onSelectUnit} highlightSelection={false} />
    );
  }

  // Tablet: side-by-side, defaulting to the top-ranked unit.
  const detailRow = selectedRow ?? rows[0];
  return (
    <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
      <View style={{ width: 340 }}>
        <HotSpotList
          rows={rows}
          selectedUnit={detailRow.unitNumber}
          onSelectUnit={onSelectUnit}
          highlightSelection
        />
      </View>
      <View style={{ flex: 1 }}>
        <DetailPane row={detailRow} nowMs={nowMs} />
      </View>
    </View>
  );
}
