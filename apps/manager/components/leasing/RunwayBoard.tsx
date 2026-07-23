import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { Chip, StageBar } from "@/components/work/primitives";
import type { PipelineRow, VacancyRow } from "@/lib/derived/leasing";
import type { MakeReadyRow } from "@/lib/derived/work-boards";
import { activeLocale } from "@/lib/i18n";
import { HAIRLINE, MUTED, NAVY } from "@/theme/tokens";

/**
 * Leasing · Runway (mockup frame 08): the make-ready → full-approval kanban.
 * Five columns read left to right — In turn · Leasable now · Applied ·
 * Approved · Signed — so "what can I lease today and what's coming" is one
 * glance. Read-only; it composes the make-ready engine, the vacancy book, and
 * the application pipeline the screen already derives.
 */

const COL_W = 210;
const CARD_CAP = 4;

function shortDate(ms: number | null): string {
  return ms === null ? "—" : new Date(ms).toLocaleDateString(activeLocale(), { month: "short", day: "numeric" });
}

function money(n: number | null): string {
  return n === null ? "" : `$${Math.round(n).toLocaleString()}`;
}

function Column({
  dot,
  title,
  subtitle,
  count,
  accent,
  children,
}: {
  dot: string;
  title: string;
  subtitle: string;
  count: number;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        width: COL_W,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: accent ? "rgba(51,166,102,0.4)" : HAIRLINE,
        backgroundColor: accent ? "rgba(51,166,102,0.05)" : "rgba(255,255,255,0.5)",
        padding: 10,
        gap: 8,
      }}
    >
      <View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
          <Text style={{ flex: 1, fontSize: 12, fontWeight: "800", color: NAVY }}>{title}</Text>
          <Text style={{ fontSize: 12, fontWeight: "800", color: MUTED, fontVariant: ["tabular-nums"] }}>{count}</Text>
        </View>
        <Text style={{ fontSize: 9, color: MUTED, marginTop: 2 }}>{subtitle}</Text>
      </View>
      {children}
    </View>
  );
}

function KCard({ children, danger, ready }: { children: React.ReactNode; danger?: boolean; ready?: boolean }) {
  return (
    <AppCardSurface
      kind="row"
      style={{
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 4,
        ...(danger ? { borderColor: "rgba(209,56,46,0.35)" } : null),
        ...(ready ? { borderColor: "rgba(51,166,102,0.4)" } : null),
      }}
    >
      {children}
    </AppCardSurface>
  );
}

function MoreCard({ label }: { label: string }) {
  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: HAIRLINE, paddingVertical: 8, alignItems: "center" }}>
      <Text style={{ fontSize: 10, color: MUTED, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

function unitTop(unit: string, chip?: React.ReactNode) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text style={{ flex: 1, fontSize: 12, fontWeight: "800", color: NAVY, fontVariant: ["tabular-nums"] }}>{unit}</Text>
      {chip}
    </View>
  );
}

export function RunwayBoard({
  inTurn,
  leasable,
  applied,
  approved,
  signed,
  rentFor,
}: {
  inTurn: MakeReadyRow[];
  leasable: VacancyRow[];
  applied: PipelineRow[];
  approved: PipelineRow[];
  signed: PipelineRow[];
  rentFor: (unitNumber: string) => number | null;
}) {
  const { t } = useTranslation();

  const flow = [
    { label: t("leasing.runway.inTurn"), count: inTurn.length },
    { label: t("leasing.runway.leasable"), count: leasable.length, green: true },
    { label: t("leasing.runway.applied"), count: applied.length },
    { label: t("leasing.runway.approved"), count: approved.length },
    { label: t("leasing.runway.signed"), count: signed.length },
  ];

  const personCard = (row: PipelineRow, chip?: React.ReactNode) => (
    <KCard key={row.lease.id}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: NAVY }}>
          {row.tenantName || "—"}
        </Text>
        {chip}
      </View>
      <Text style={{ fontSize: 9.5, color: MUTED, fontVariant: ["tabular-nums"] }}>
        {row.lease.unitNumber ? `→ ${row.lease.unitNumber}` : ""}
        {row.moveInMs !== null ? ` · ${shortDate(row.moveInMs)}` : ""}
      </Text>
    </KCard>
  );

  return (
    <View>
      {/* Flow strip — the pipeline in one line. */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 12, paddingHorizontal: 2 }}>
        {flow.map((s, i) => (
          <View key={s.label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View
              style={{
                flexDirection: "row",
                gap: 5,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: s.green ? "rgba(51,166,102,0.5)" : HAIRLINE,
                paddingHorizontal: 9,
                paddingVertical: 3,
              }}
            >
              <Text style={{ fontSize: 10.5, fontWeight: "800", color: s.green ? "#1F7A47" : NAVY }}>{s.label}</Text>
              <Text style={{ fontSize: 10.5, fontWeight: "800", color: MUTED, fontVariant: ["tabular-nums"] }}>{s.count}</Text>
            </View>
            {i < flow.length - 1 ? <Text style={{ fontSize: 11, color: MUTED }}>→</Text> : null}
          </View>
        ))}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>
        {/* In turn */}
        <Column dot="#458ADB" title={t("leasing.runway.inTurnTitle")} subtitle={t("leasing.runway.inTurnSub")} count={inTurn.length}>
          {inTurn.slice(0, CARD_CAP).map((r) => {
            const blocked = r.blockedStages.length > 0;
            return (
              <KCard key={r.unitNumber} danger={blocked}>
                {unitTop(
                  r.unitNumber,
                  blocked ? (
                    <Chip label={t("leasing.runway.blocked")} tone="blocked" />
                  ) : r.moveInAt !== null ? (
                    <Chip label={shortDate(r.moveInAt)} tone="ready" />
                  ) : undefined,
                )}
                <StageBar total={r.totalStages} done={r.completedStages} blocked={r.blockedStages.length} />
                <Text style={{ fontSize: 9.5, color: MUTED }}>
                  {blocked
                    ? t("leasing.runway.noProjection", { stage: t(`work.stages.${r.blockedStages[0]}`) })
                    : `${r.completedStages}/${r.totalStages}${r.currentStage ? ` · ${t(`work.stages.${r.currentStage}`)}` : ""}${
                        rentFor(r.unitNumber) !== null ? ` · ${money(rentFor(r.unitNumber))}` : ""
                      }`}
                </Text>
              </KCard>
            );
          })}
          {inTurn.length > CARD_CAP ? <MoreCard label={t("leasing.runway.more", { count: inTurn.length - CARD_CAP })} /> : null}
        </Column>

        {/* Leasable now */}
        <Column dot="#33A666" title={t("leasing.runway.leasableTitle")} subtitle={t("leasing.runway.leasableSub")} count={leasable.length} accent>
          {leasable.slice(0, CARD_CAP).map((r) => (
            <KCard key={r.unitNumber} ready>
              {unitTop(r.unitNumber)}
              <Text style={{ fontSize: 9.5, color: MUTED }}>
                {[r.classification, money(r.marketRent)].filter(Boolean).join(" · ")}
              </Text>
            </KCard>
          ))}
          {leasable.length > CARD_CAP ? <MoreCard label={t("leasing.runway.moreReady", { count: leasable.length - CARD_CAP })} /> : null}
        </Column>

        {/* Applied */}
        <Column dot="#458ADB" title={t("leasing.runway.appliedTitle")} subtitle={t("leasing.runway.appliedSub")} count={applied.length}>
          {applied.slice(0, CARD_CAP).map((r) => personCard(r, <Chip label={t("leasing.stages.screening")} tone="high" />))}
          {applied.length > CARD_CAP ? <MoreCard label={t("leasing.runway.more", { count: applied.length - CARD_CAP })} /> : null}
        </Column>

        {/* Approved */}
        <Column dot="#7A6BC7" title={t("leasing.runway.approvedTitle")} subtitle={t("leasing.runway.approvedSub")} count={approved.length}>
          {approved.slice(0, CARD_CAP).map((r) => personCard(r))}
          {approved.length > CARD_CAP ? <MoreCard label={t("leasing.runway.more", { count: approved.length - CARD_CAP })} /> : null}
        </Column>

        {/* Signed */}
        <Column dot="#33A666" title={t("leasing.runway.signedTitle")} subtitle={t("leasing.runway.signedSub")} count={signed.length}>
          {signed.slice(0, CARD_CAP).map((r) =>
            personCard(r, r.stage === "movedIn" ? <Chip label={t("leasing.runway.movedIn")} tone="ready" /> : undefined),
          )}
          {signed.length > CARD_CAP ? <MoreCard label={t("leasing.runway.more", { count: signed.length - CARD_CAP })} /> : null}
        </Column>
      </ScrollView>
    </View>
  );
}
