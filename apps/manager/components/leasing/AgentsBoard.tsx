import { useTranslation } from "react-i18next";
import { Text, View, useWindowDimensions } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import type { AgentFlag, LeasingAgentRow, LeasingAgentBoard } from "@/lib/derived/leasing-agents";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE_SOFT, MUTED, NAVY } from "@/theme/tokens";

/**
 * Leasing · Agents (mockup frame 10): per-agent application production. One
 * card per agent — the week/month counts, the applied→moved-in funnel, the
 * conversion, and days-to-keys — plus the 8-week cadence and the stalled queue.
 * Read-only; pairs with Money · By Agent (book quality after signature).
 */

const FUNNEL = [
  { key: "applied" as const, color: "rgba(9,27,84,0.18)" },
  { key: "approved" as const, color: "#458ADB" },
  { key: "signed" as const, color: "#A2A921" },
  { key: "movedIn" as const, color: "#33A666" },
];

const FLAG_STYLE: Record<Exclude<AgentFlag, null>, { bg: string; fg: string; key: string }> = {
  best: { bg: "rgba(51,166,102,0.14)", fg: "#1F7A47", key: "leasing.agents.flagBest" },
  stalling: { bg: "rgba(209,56,46,0.12)", fg: "#D1382E", key: "leasing.agents.flagStalling" },
  lowVolume: { bg: "rgba(9,27,84,0.07)", fg: "#4C556F", key: "leasing.agents.flagLowVolume" },
};

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 15, fontWeight: "800", color: muted ? MUTED : NAVY, fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
      <Text style={{ fontSize: 8.5, fontWeight: "700", letterSpacing: 0.3, color: MUTED, textTransform: "uppercase", marginTop: 1 }}>
        {label}
      </Text>
    </View>
  );
}

function FunnelBar({ funnel }: { funnel: LeasingAgentRow["funnel"] }) {
  const total = FUNNEL.reduce((s, seg) => s + funnel[seg.key], 0);
  if (total === 0) return <View style={{ height: 10, borderRadius: 5, backgroundColor: HAIRLINE_SOFT }} />;
  return (
    <View style={{ flexDirection: "row", height: 10, borderRadius: 5, overflow: "hidden", backgroundColor: HAIRLINE_SOFT }}>
      {FUNNEL.map((seg) =>
        funnel[seg.key] > 0 ? (
          <View key={seg.key} style={{ flex: funnel[seg.key], backgroundColor: seg.color }} />
        ) : null,
      )}
    </View>
  );
}

function AgentCard({ row }: { row: LeasingAgentRow }) {
  const { t } = useTranslation();
  const flag = row.flag ? FLAG_STYLE[row.flag] : null;
  const delta = row.appsThisWeek - row.appsLastWeek;
  return (
    <AppCardSurface
      kind="panel"
      style={{
        paddingHorizontal: 16,
        paddingVertical: 13,
        marginBottom: 10,
        ...(row.flag === "stalling" ? { backgroundColor: "rgba(209,56,46,0.04)" } : null),
        ...(row.isOffice ? { opacity: 0.82 } : null),
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View
          style={{
            width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center",
            backgroundColor: row.rank === 1 ? "rgba(51,166,102,0.16)" : "rgba(9,27,84,0.06)",
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: "800", color: row.rank === 1 ? "#1F7A47" : MUTED }}>
            {row.rank ?? "—"}
          </Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "800", color: NAVY }}>
            {row.isOffice ? t("leasing.agents.office") : row.agent}
          </Text>
          <Text style={{ fontSize: 9.5, color: MUTED }}>
            {t("leasing.agents.activeLeases", { count: row.activeLeases })}
          </Text>
        </View>
        {flag ? (
          <View style={{ backgroundColor: flag.bg, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 }}>
            <Text style={{ fontSize: 9, fontWeight: "800", color: flag.fg }}>{t(flag.key)}</Text>
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
        <Stat
          label={t("leasing.agents.colThisWeek")}
          value={`${row.appsThisWeek}${delta !== 0 ? (delta > 0 ? ` ▲${delta}` : ` ▼${-delta}`) : ""}`}
        />
        <Stat label={t("leasing.agents.colLastWeek")} value={String(row.appsLastWeek)} muted />
        <Stat label={t("leasing.agents.colMonth")} value={String(row.appsThisMonth)} />
        <Stat
          label={t("leasing.agents.colMoveIns")}
          value={`${row.moveIns90}${row.conversionPct !== null ? ` · ${Math.round(row.conversionPct)}%` : ""}`}
        />
        <Stat
          label={t("leasing.agents.colKeys")}
          value={row.medianAppToKeysDays === null ? "—" : `${row.medianAppToKeysDays}d`}
        />
      </View>

      <View style={{ marginTop: 11 }}>
        <FunnelBar funnel={row.funnel} />
      </View>
    </AppCardSurface>
  );
}

function AppsPerWeekCard({ values }: { values: number[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...values);
  return (
    <AppCardSurface kind="panel" style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
      <Text style={{ fontSize: 13, fontWeight: "800", color: NAVY, marginBottom: 10 }}>
        {t("leasing.agents.appsPerWeek")}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4, height: 60 }}>
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
      <Text style={{ fontSize: 8.5, fontWeight: "700", color: MUTED, marginTop: 5 }}>
        {t("leasing.agents.appsPerWeekCaption", { count: values.length })}
      </Text>
    </AppCardSurface>
  );
}

function StalledCard({ board }: { board: LeasingAgentBoard }) {
  const { t } = useTranslation();
  return (
    <AppCardSurface kind="panel" style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
      <Text style={{ fontSize: 13, fontWeight: "800", color: NAVY, marginBottom: 8 }}>
        {t("leasing.agents.stalled")}
      </Text>
      {board.stalled.length === 0 ? (
        <Text style={{ fontSize: 11, color: MUTED }}>{t("leasing.agents.noStalled")}</Text>
      ) : (
        board.stalled.map((s, i) => (
          <View
            key={`${s.unitNumber}-${i}`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingVertical: 7,
              borderBottomWidth: i === board.stalled.length - 1 ? 0 : 1,
              borderBottomColor: HAIRLINE_SOFT,
            }}
          >
            <Text style={{ width: 70, fontSize: 12, fontWeight: "800", color: NAVY, fontVariant: ["tabular-nums"] }}>
              {s.unitNumber || "—"}
            </Text>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 10.5, color: MUTED }}>
              {s.agent || t("leasing.agents.office")}
            </Text>
            <Text style={{ fontSize: 11, fontWeight: "800", color: s.ageDays > 14 ? "#D1382E" : "#B05E14" }}>
              {t("work.days", { count: s.ageDays })}
            </Text>
          </View>
        ))
      )}
    </AppCardSurface>
  );
}

export function AgentsBoard({ board }: { board: LeasingAgentBoard }) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const wide = width >= 1040;

  const weekOf = new Date(board.lastWeekStartMs).toLocaleDateString(activeLocale(), {
    month: "short",
    day: "numeric",
  });

  const funnelLegend = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: 12, paddingHorizontal: 2 }}>
      {FUNNEL.map((seg) => (
        <View key={seg.key} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: seg.color }} />
          <Text style={{ fontSize: 9, fontWeight: "700", color: MUTED, textTransform: "uppercase", letterSpacing: 0.3 }}>
            {t(`leasing.agents.stage.${seg.key}`)}
          </Text>
        </View>
      ))}
    </View>
  );

  if (board.rows.length === 0) {
    return (
      <AppCardSurface kind="panel" style={{ padding: 26, alignItems: "center" }}>
        <Text style={{ fontSize: 12, color: MUTED, textAlign: "center" }}>{t("leasing.agents.empty")}</Text>
      </AppCardSurface>
    );
  }

  return (
    <View>
      <Text style={{ fontSize: 10.5, color: MUTED, marginBottom: 10, paddingHorizontal: 2 }}>
        {t("leasing.agents.weekOf", { date: weekOf })}
      </Text>
      {board.rows.map((row) => (
        <AgentCard key={row.agent || "office"} row={row} />
      ))}
      {funnelLegend}
      {wide ? (
        <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
          <View style={{ flex: 1 }}>
            <AppsPerWeekCard values={board.appsPerWeek} />
          </View>
          <View style={{ flex: 1 }}>
            <StalledCard board={board} />
          </View>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          <AppsPerWeekCard values={board.appsPerWeek} />
          <StalledCard board={board} />
        </View>
      )}
    </View>
  );
}
