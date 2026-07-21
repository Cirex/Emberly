import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Linking, Text, View } from "react-native";
import {
  ActionButton,
  KeyValue,
  Lead,
  ListFooter,
  MetricStrip,
  MiniCard,
  NoteBox,
  PEOPLE_COLORS,
  Pill,
  PlateChip,
  Row,
  SectionLabel,
  type PillTone,
} from "@/components/people/bits";
import {
  currentPolicy,
  daysUntil,
  fmtBirthdate,
  fmtMoney,
  fmtMoneyCompact,
  fmtPercent,
  fmtPhone,
  fmtShortDate,
  incomeVerdict,
  policyLast4,
  profileSubline,
} from "@/components/people/format";
import { capture } from "@/lib/analytics";
import type { TenantProfile as TenantProfileData } from "@/lib/api/people";

/**
 * The tenant profile — the mockup's sheet, section for section: action row,
 * three-metric strip, Household, Vehicles, Insurance, Emergency contact,
 * Employment, Identity, Maintenance.
 *
 * MASKING IS THE DEFAULT. Birthdate, driver's licence and monthly income are
 * not in the payload this component renders until the manager taps "reveal" on
 * that one field; the tap refetches with `includePii`, which the server writes
 * to the admin audit log. `revealed` is the per-person list of fields already
 * unmasked this session.
 *
 * Rendered as the sheet body on phone and as the split's right pane on iPad —
 * it is layout-agnostic on purpose.
 */

/** Which masked fields exist. Values ride the audit log and analytics. */
export type PiiField = "birthdate" | "drivers_license" | "monthly_income";

const COLOR_SWATCHES: Record<string, string> = {
  black: "#1C2440",
  white: "#F2F1EC",
  silver: "#C9CDD2",
  gray: "#9096A1",
  grey: "#9096A1",
  red: "#C0392B",
  blue: "#2563B4",
  navy: "#1B2A5B",
  green: "#2F7D4F",
  brown: "#7A5334",
  tan: "#C8B08A",
  gold: "#C8A93B",
  beige: "#DCCFB4",
  orange: "#DE7A2C",
  yellow: "#D9C33C",
  purple: "#7A6BC7",
  maroon: "#6E2B32",
};

function swatchFor(color: string): string {
  return COLOR_SWATCHES[color.trim().toLowerCase()] ?? "rgba(9,27,84,0.18)";
}

export function TenantProfile({
  profile,
  loading,
  error,
  revealed,
  onReveal,
  onLedger,
  nowMs,
  showHeader = false,
}: {
  profile: TenantProfileData | null;
  loading: boolean;
  error?: string;
  /** Fields already unmasked for this person this session. */
  revealed: string[];
  /** Fetches the PII payload for one field; resolves false on failure. */
  onReveal: (field: PiiField) => Promise<boolean>;
  /** "Ledger ›" — analytics-only stub until the cross-nav lands. */
  onLedger: () => void;
  /** Stable "now" for the countdowns (the last sync, not Date.now in render). */
  nowMs: number;
  /** iPad split pane draws its own name header; the phone sheet already has one. */
  showHeader?: boolean;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PiiField | null>(null);

  if (loading && !profile) {
    return (
      <View style={{ paddingVertical: 40, alignItems: "center" }}>
        <ActivityIndicator />
        <Text style={{ marginTop: 10, fontSize: 12, color: PEOPLE_COLORS.muted }}>
          {t("people.empty.loading")}
        </Text>
      </View>
    );
  }

  if (!profile) {
    return (
      <Text
        style={{
          paddingHorizontal: 18,
          paddingVertical: 32,
          textAlign: "center",
          fontSize: 12.5,
          color: PEOPLE_COLORS.muted,
        }}
      >
        {error ? t("people.empty.failed") : t("people.empty.selectPrompt")}
      </Text>
    );
  }

  const { resident, lease } = profile;
  const name = `${resident.firstName} ${resident.lastName}`.trim();
  const phone = resident.phones[0] ?? "";
  const email = resident.email.trim();

  const contact = (method: "call" | "message" | "email") => {
    const url =
      method === "call" ? `tel:${phone}` : method === "message" ? `sms:${phone}` : `mailto:${email}`;
    capture("tenant_contact_action", { method });
    void Linking.openURL(url).catch(() => {
      /* No dialer/mail client (simulator, iPad without cellular) — nothing to
         recover from; the button simply does nothing. */
    });
  };

  const reveal = async (field: PiiField) => {
    if (pending) return;
    setPending(field);
    const ok = await onReveal(field);
    setPending(null);
    if (ok) capture("tenant_pii_revealed", { field });
  };

  const isRevealed = (field: PiiField) => revealed.includes(field);

  // ---- metric strip -------------------------------------------------------
  const balance = lease?.balance ?? 0;
  const timesLate = lease?.timesLate ?? 0;
  const policy = currentPolicy(profile.insurance);
  const insuranceDays = daysUntil(policy?.endDate, nowMs);

  const insuranceMetric = (() => {
    if (!policy || insuranceDays === null) {
      return { value: "—", tint: PEOPLE_COLORS.muted, caption: t("people.metrics.insuranceNone") };
    }
    if (insuranceDays < 0) {
      return {
        value: `${Math.abs(insuranceDays)}d`,
        tint: PEOPLE_COLORS.bad,
        caption: t("people.metrics.insuranceLapsed", { date: fmtShortDate(policy.endDate) }),
      };
    }
    return {
      value: `${insuranceDays}d`,
      tint: insuranceDays <= 30 ? PEOPLE_COLORS.warn : PEOPLE_COLORS.pos,
      caption: t("people.metrics.insuranceCaption", { date: fmtShortDate(policy.endDate) }),
    };
  })();

  const ratio = profile.rentToIncomeRatio;
  const verdict = ratio === null || ratio === undefined ? null : incomeVerdict(ratio);
  const verdictTone: PillTone =
    verdict === "healthy" ? "good" : verdict === "elevated" ? "soon" : "late";

  const incomeField = profile.employment[0];
  const incomeRevealed = isRevealed("monthly_income");

  return (
    <View>
      {showHeader ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingHorizontal: 18,
            paddingTop: 14,
          }}
        >
          <Lead name={name} size={38} />
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: PEOPLE_COLORS.navy }}
          >
            {name}
          </Text>
          <Pill
            tone={balance > 0 ? "late" : "good"}
            label={balance > 0 ? t("people.status.owes", { amount: fmtMoney(balance) }) : t("people.status.current")}
          />
        </View>
      ) : null}
      {showHeader ? (
        <Text style={{ paddingHorizontal: 18, paddingTop: 3, fontSize: 10.5, color: PEOPLE_COLORS.muted }}>
          {profileSubline(profile, t)}
        </Text>
      ) : null}

      {/* Action row */}
      <View style={{ flexDirection: "row", gap: 7, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 8 }}>
        <ActionButton primary label={t("people.actions.call")} disabled={phone === ""} onPress={() => contact("call")} />
        <ActionButton label={t("people.actions.message")} disabled={phone === ""} onPress={() => contact("message")} />
        <ActionButton label={t("people.actions.email")} disabled={email === ""} onPress={() => contact("email")} />
        <ActionButton label={t("people.actions.ledger")} onPress={onLedger} />
      </View>

      <MetricStrip
        metrics={[
          {
            value: fmtMoneyCompact(Math.max(0, balance)),
            tint: balance > 0 ? PEOPLE_COLORS.bad : PEOPLE_COLORS.pos,
            label: t("people.metrics.balance"),
            caption:
              balance > 0
                ? t("people.metrics.balanceOwed")
                : t("people.metrics.balanceCurrent", { count: timesLate }),
          },
          {
            value: "—",
            tint: PEOPLE_COLORS.muted,
            label: t("people.metrics.netPosition"),
            caption: t("people.metrics.netPositionCaption"),
          },
          {
            value: insuranceMetric.value,
            tint: insuranceMetric.tint,
            label: t("people.metrics.insurance"),
            caption: insuranceMetric.caption,
          },
        ]}
      />

      {/* Household */}
      <SectionLabel label={t("people.sections.household")} count={profile.household.length + 1} />
      {profile.household.map((member) => {
        const memberName = `${member.firstName} ${member.lastName}`.trim();
        const status = [
          member.isPrimary ? t("people.status.primary") : t("people.status.occupant"),
          member.householdStatus,
        ]
          .filter((p) => p !== "")
          .join(" · ");
        return (
          <Row
            key={member.personLeaseId}
            lead={<Lead name={memberName} />}
            title={memberName}
            subtitle={status}
            right={
              <Pill
                tone={member.isPrimary ? "ok" : "neutral"}
                label={member.isPrimary ? t("people.status.primary") : t("people.status.occupant")}
              />
            }
          />
        );
      })}

      {/* Vehicles */}
      <SectionLabel label={t("people.sections.vehicles")} count={profile.vehicles.length} />
      {profile.vehicles.length === 0 ? (
        <MiniCard>
          <Text style={{ fontSize: 10.5, color: PEOPLE_COLORS.muted }}>{t("people.vehicles.none")}</Text>
        </MiniCard>
      ) : (
        profile.vehicles.map((vehicle) => {
          const title = [vehicle.year, vehicle.make, vehicle.model].filter((p) => p !== "").join(" ");
          const color = vehicle.color.trim() || t("people.vehicles.unknownColor");
          const hasSpot = vehicle.parkingSpot !== "";
          return (
            <MiniCard key={vehicle.id} tone={hasSpot ? "plain" : "warn"}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    borderWidth: 1,
                    borderColor: "rgba(9,27,84,0.2)",
                    backgroundColor: swatchFor(vehicle.color),
                  }}
                />
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "800", color: PEOPLE_COLORS.navy }}>
                  {title || vehicle.plate}
                </Text>
                <PlateChip plate={vehicle.plate} state={vehicle.state} />
              </View>
              <Text style={{ fontSize: 9.5, color: hasSpot ? PEOPLE_COLORS.muted : PEOPLE_COLORS.warn, marginTop: 3 }}>
                {hasSpot
                  ? t("people.vehicles.spot", { color, spot: vehicle.parkingSpot })
                  : t("people.vehicles.noSpot", { color })}
              </Text>
            </MiniCard>
          );
        })
      )}

      {/* Insurance */}
      <SectionLabel label={t("people.sections.insurance")} />
      {!policy ? (
        <MiniCard tone="warn">
          <Text style={{ fontSize: 11, fontWeight: "700", color: PEOPLE_COLORS.warn }}>
            {t("people.insurance.none")}
          </Text>
        </MiniCard>
      ) : (
        <MiniCard
          tone={
            insuranceDays !== null && insuranceDays < 0
              ? "bad"
              : insuranceDays !== null && insuranceDays <= 30
                ? "warn"
                : "plain"
          }
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "800", color: PEOPLE_COLORS.navy }}>
              {policy.provider || "—"}
            </Text>
            {insuranceDays === null ? (
              <Pill tone="neutral" label={policy.status || t("people.insurance.active")} />
            ) : insuranceDays < 0 ? (
              <Pill tone="late" label={t("people.insurance.lapsedDays", { count: Math.abs(insuranceDays) })} />
            ) : (
              <Pill
                tone={insuranceDays <= 30 ? "soon" : "good"}
                label={t("people.insurance.expiresInDays", { count: insuranceDays })}
              />
            )}
          </View>
          <Text style={{ fontSize: 9.5, color: PEOPLE_COLORS.muted, marginTop: 3 }}>
            {policy.endDate
              ? t("people.insurance.detail", {
                  type: policy.policyType || "—",
                  policy: policyLast4(policy.policyNumber),
                  coverage: policy.coverageAmount ? fmtMoney(policy.coverageAmount) : "—",
                  date: fmtShortDate(policy.endDate),
                })
              : t("people.insurance.detailNoEnd", {
                  type: policy.policyType || "—",
                  policy: policyLast4(policy.policyNumber),
                  coverage: policy.coverageAmount ? fmtMoney(policy.coverageAmount) : "—",
                })}
          </Text>
        </MiniCard>
      )}

      {/* Emergency contact */}
      <SectionLabel label={t("people.sections.emergency")} />
      {(() => {
        const emergency =
          profile.alternateContacts.find((c) => c.isEmergencyContact) ?? profile.alternateContacts[0];
        if (!emergency) {
          return (
            <MiniCard>
              <Text style={{ fontSize: 10.5, color: PEOPLE_COLORS.muted }}>{t("people.contacts.none")}</Text>
            </MiniCard>
          );
        }
        const line = [emergency.phone ? fmtPhone(emergency.phone) : "", emergency.email]
          .filter((p) => p !== "")
          .join(" · ");
        return (
          <MiniCard>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "800", color: PEOPLE_COLORS.navy }}>
                {emergency.name || "—"}
              </Text>
              {emergency.relationship ? <Pill tone="blue" label={emergency.relationship} /> : null}
            </View>
            {line ? (
              <Text style={{ fontSize: 9.5, color: PEOPLE_COLORS.muted, marginTop: 3 }}>{line}</Text>
            ) : null}
          </MiniCard>
        );
      })()}

      {/* Employment — income masked, ratio always shown */}
      <SectionLabel label={t("people.sections.employment")} />
      {!incomeField ? (
        <MiniCard>
          <Text style={{ fontSize: 10.5, color: PEOPLE_COLORS.muted }}>{t("people.employment.none")}</Text>
        </MiniCard>
      ) : (
        <>
          <KeyValue label={t("people.employment.employer")} value={incomeField.employerName || "—"} />
          <KeyValue label={t("people.employment.position")} value={incomeField.position || "—"} />
          <KeyValue
            label={t("people.employment.monthlyIncome")}
            masked={!incomeRevealed}
            maskedPlaceholder={t("people.masked.money")}
            revealLabel={pending === "monthly_income" ? t("people.revealing") : t("people.reveal")}
            onReveal={() => void reveal("monthly_income")}
            value={
              incomeRevealed && typeof incomeField.monthlyIncome === "number"
                ? fmtMoney(incomeField.monthlyIncome)
                : "—"
            }
          />
        </>
      )}
      <KeyValue
        label={t("people.employment.rentToIncome")}
        value={ratio === null || ratio === undefined ? t("people.employment.unknown") : fmtPercent(ratio)}
        trailing={verdict ? <Pill tone={verdictTone} label={t(`people.employment.${verdict}`)} /> : undefined}
      />

      {/* Identity — masked, one field at a time, every reveal audited */}
      <SectionLabel label={t("people.sections.identity")} />
      <KeyValue
        label={t("people.identity.dateOfBirth")}
        masked={!isRevealed("birthdate")}
        maskedPlaceholder={t("people.masked.date")}
        revealLabel={pending === "birthdate" ? t("people.revealing") : t("people.reveal")}
        onReveal={() => void reveal("birthdate")}
        value={fmtBirthdate(resident.birthdate) || "—"}
      />
      <KeyValue
        label={t("people.identity.driversLicense")}
        masked={!isRevealed("drivers_license")}
        maskedPlaceholder={t("people.masked.text")}
        revealLabel={pending === "drivers_license" ? t("people.revealing") : t("people.reveal")}
        onReveal={() => void reveal("drivers_license")}
        value={
          [resident.driversLicense, resident.driversLicenseState].filter((p) => p).join(" · ") || "—"
        }
      />
      <NoteBox>{t("people.identity.note")}</NoteBox>

      {/* Maintenance */}
      <SectionLabel label={t("people.sections.maintenance")} count={t("people.sections.maintenanceWindow")} />
      {profile.workOrders.length === 0 ? (
        <MiniCard>
          <Text style={{ fontSize: 10.5, color: PEOPLE_COLORS.muted }}>{t("people.maintenance.none")}</Text>
        </MiniCard>
      ) : (
        profile.workOrders.map((wo) => {
          const closed = wo.dateCompleted !== null && wo.dateCompleted !== undefined;
          const opened = wo.dateReported ? Date.parse(wo.dateReported) : NaN;
          const done = wo.dateCompleted ? Date.parse(wo.dateCompleted) : NaN;
          const days =
            Number.isNaN(opened) || Number.isNaN(done)
              ? null
              : Math.max(0, Math.round((done - opened) / 86_400_000));
          const sub = [
            closed
              ? t("people.maintenance.closed", { date: fmtShortDate(wo.dateCompleted) })
              : t("people.maintenance.reported", { date: fmtShortDate(wo.dateReported) }),
            days === null ? "" : t("people.maintenance.days", { count: days }),
            wo.technician,
          ]
            .filter((p) => p !== "")
            .join(" · ");
          const callback = wo.callbackStatus === "confirmed" || wo.callbackStatus === "possible";
          return (
            <Row
              key={wo.id}
              title={wo.title || wo.number}
              subtitle={sub}
              right={
                <Pill
                  tone={callback ? "review" : closed ? "good" : "neutral"}
                  label={
                    callback
                      ? t("people.maintenance.callback")
                      : closed
                        ? t("people.maintenance.closedPill")
                        : t("people.maintenance.open")
                  }
                />
              }
            />
          );
        })
      )}

      <ListFooter>{t("people.footer.opensFrom")}</ListFooter>
    </View>
  );
}
