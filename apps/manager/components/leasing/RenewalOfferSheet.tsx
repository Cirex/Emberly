import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatDay } from "@/components/leasing/rows";
import { useOfferTermLabel } from "@/components/leasing/renewal-rows";
import type { ManagerLease } from "@/lib/api/leases";
import type { RenewalOffer, RenewalResolutionStatus } from "@/lib/api/renewals";
import { signedMoney } from "@/lib/derived/leasing";
import {
  defaultProposedRent,
  rentDelta,
  RENT_STEP,
  type InternalComps,
  type OfferTimelineItem,
  type RenewalSubject,
} from "@/lib/derived/renewals-view";
import { activeLocale } from "@/lib/i18n";
import { MUTED, NAVY } from "@/theme/tokens";

/**
 * The renewal offer sheet — the mockup's "Offer sheet · 0327 Reyes" phone,
 * faithfully: title "Renewal offer · <unit>", the tenant subline ("never
 * late" only when timesLate is known and zero), Current/Market rent rows with
 * mark-to-market, the blue internal-comps callout, the $5 proposed-rent
 * stepper with the live "+$X · Y%" chip, term chips (12 mo / 14 mo / MTM),
 * the send CTA, and the derived TIMELINE. When a sent offer is already out,
 * the draft controls give way to the offer summary + response recording
 * (accepted / declined / withdraw). Mount with a fresh `key` per open so
 * state resets without effects.
 */

export interface RenewalOfferDraft {
  proposedRent: number;
  termMonths?: number;
  isMonthToMonth?: boolean;
  priorRent?: number;
}

type TermKey = "12" | "14" | "mtm";

const GOOD = "#1F7A47";
const BAD = "#D1382E";

function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

/** "May 2024" in the active locale. */
function formatMonthYear(ms: number): string {
  return new Date(ms).toLocaleDateString(activeLocale(), { month: "long", year: "numeric" });
}

export function RenewalOfferSheet({
  visible,
  lease,
  subject,
  comps,
  activeOffer,
  timeline,
  onClose,
  onSend,
  onResolve,
}: {
  visible: boolean;
  lease: ManagerLease;
  subject: RenewalSubject;
  comps: InternalComps | null;
  /** The governing offer still awaiting a response, if any. */
  activeOffer: RenewalOffer | null;
  timeline: OfferTimelineItem[];
  onClose: () => void;
  onSend: (draft: RenewalOfferDraft) => Promise<boolean>;
  onResolve: (offerId: string, status: RenewalResolutionStatus) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const termLabel = useOfferTermLabel();
  const [proposed, setProposed] = useState(() => defaultProposedRent(subject));
  const [term, setTerm] = useState<TermKey>("12");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const delta = rentDelta(proposed, subject.currentRent);

  const subParts = [
    subject.tenantName,
    [
      subject.bedrooms !== null ? t("leasing.renewals.sheet.bedrooms", { count: subject.bedrooms }) : "",
      subject.classification,
    ]
      .filter(Boolean)
      .join(" "),
    subject.inSinceMs !== null
      ? t("leasing.renewals.sheet.inSince", { date: formatMonthYear(subject.inSinceMs) })
      : "",
    subject.neverLate ? t("leasing.renewals.sheet.neverLate") : "",
    subject.endMs !== null
      ? t("leasing.renewals.sheet.leaseEnds", { date: formatDay(subject.endMs) })
      : "",
  ].filter(Boolean);

  const send = async () => {
    if (saving) return;
    setError(null);
    setSaving(true);
    const ok = await onSend({
      proposedRent: proposed,
      termMonths: term === "mtm" ? undefined : Number(term),
      isMonthToMonth: term === "mtm" ? true : undefined,
      priorRent: subject.currentRent ?? undefined,
    });
    setSaving(false);
    if (ok) onClose();
    else setError(t("leasing.renewals.sheet.sendFailed"));
  };

  const resolve = async (status: RenewalResolutionStatus) => {
    if (saving || !activeOffer) return;
    setError(null);
    setSaving(true);
    const ok = await onResolve(activeOffer.id, status);
    setSaving(false);
    if (ok) onClose();
    else setError(t("leasing.renewals.sheet.resolveFailed"));
  };

  const kvRow = (label: string, value: React.ReactNode) => (
    <View style={{ flexDirection: "row", paddingHorizontal: 18, paddingVertical: 6, gap: 10, alignItems: "baseline" }}>
      <Text style={{ fontSize: 10.5, color: MUTED, width: 110 }}>{label}</Text>
      <View style={{ flex: 1 }}>{value}</View>
    </View>
  );

  const kvValue = (text: string) => (
    <Text style={{ fontSize: 12, fontWeight: "700", color: NAVY, fontVariant: ["tabular-nums"] }}>{text}</Text>
  );

  const stepBtn = (label: string, onPress: () => void) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: 30,
        height: 30,
        borderRadius: 15,
        borderWidth: 1,
        borderColor: "rgba(9,27,84,0.15)",
        backgroundColor: "#FFFFFF",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: 15, fontWeight: "800", color: NAVY }}>{label}</Text>
    </Pressable>
  );

  const termChip = (key: TermKey, label: string) => {
    const on = term === key;
    return (
      <Pressable
        key={key}
        onPress={() => setTerm(key)}
        accessibilityRole="button"
        accessibilityState={on ? { selected: true } : {}}
        style={{
          flex: 1,
          alignItems: "center",
          borderRadius: 10,
          paddingVertical: 8,
          borderWidth: 1,
          borderColor: on ? "rgba(162,169,33,0.5)" : "rgba(9,27,84,0.12)",
          backgroundColor: on ? "rgba(162,169,33,0.14)" : "rgba(9,27,84,0.04)",
        }}
      >
        <Text style={{ fontSize: 10.5, fontWeight: "800", color: on ? "#5C6410" : "#4C556F" }}>{label}</Text>
      </Pressable>
    );
  };

  const timelineDot = (item: OfferTimelineItem): string => {
    switch (item.kind) {
      case "windowOpened":
        return "#E38736";
      case "offerSent":
        return "#2563B4";
      case "offerResolved":
        return item.offer.status === "accepted" ? "#33A666" : item.offer.status === "declined" ? BAD : MUTED;
      case "noOfferYet":
        return "rgba(9,27,84,0.3)";
    }
  };

  const timelineWhat = (item: OfferTimelineItem): string => {
    switch (item.kind) {
      case "windowOpened":
        return t("leasing.renewals.sheet.windowOpened");
      case "offerSent":
        return t("leasing.renewals.sheet.offerSentEvent", {
          rent: money(item.offer.proposedRent),
          term: termLabel(item.offer),
        });
      case "offerResolved":
        return item.offer.status === "accepted"
          ? t("leasing.renewals.sheet.acceptedEvent")
          : item.offer.status === "declined"
            ? t("leasing.renewals.sheet.declinedEvent")
            : t("leasing.renewals.sheet.withdrawnEvent");
      case "noOfferYet":
        return t("leasing.renewals.sheet.noOfferYet");
    }
  };

  const timelineSub = (item: OfferTimelineItem): string => {
    switch (item.kind) {
      case "windowOpened":
        return t("leasing.renewals.sheet.windowOpenedSub", { date: formatDay(item.whenMs) });
      case "offerSent":
        return item.offer.createdBy
          ? t("leasing.renewals.sheet.offerSentEventSubBy", {
              date: item.whenMs !== null ? formatDay(item.whenMs) : "—",
              name: item.offer.createdBy,
            })
          : t("leasing.renewals.sheet.offerSentEventSub", {
              date: item.whenMs !== null ? formatDay(item.whenMs) : "—",
            });
      case "offerResolved":
        return t("leasing.renewals.sheet.offerSentEventSub", {
          date: item.whenMs !== null ? formatDay(item.whenMs) : "—",
        });
      case "noOfferYet":
        if (item.daysLeft === null) return "";
        return item.urgent
          ? t("leasing.renewals.sheet.noOfferDaysUrgent", { count: item.daysLeft })
          : t("leasing.renewals.sheet.noOfferDays", { count: item.daysLeft });
    }
  };

  const compsSentence = (() => {
    if (!comps) return null;
    const layout = [
      t("leasing.renewals.sheet.bedrooms", { count: comps.bedrooms }),
      comps.classification,
    ]
      .filter(Boolean)
      .join(" ");
    const body = t("leasing.renewals.sheet.compsBody", {
      count: comps.count,
      layout,
      rents: comps.rents.map(money).join(" · "),
    });
    const comparison =
      proposed < comps.minRent
        ? t("leasing.renewals.sheet.compsUnder", {
            proposed: money(proposed),
            range: `$${Math.round(comps.minRent - proposed).toLocaleString()}–${Math.round(comps.maxRent - proposed).toLocaleString()}`,
          })
        : proposed <= comps.maxRent
          ? t("leasing.renewals.sheet.compsInLine", { proposed: money(proposed) })
          : t("leasing.renewals.sheet.compsAbove", { proposed: money(proposed) });
    return `${body} ${comparison}`;
  })();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(9,27,84,0.25)" }]}
        onPress={onClose}
        accessibilityLabel={t("leasing.renewals.sheet.close")}
      />
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
        <View
          style={{
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            backgroundColor: "rgba(250,247,240,0.99)",
            paddingBottom: Math.max(insets.bottom, 16),
            maxHeight: 640,
          }}
        >
          <View
            style={{
              alignSelf: "center",
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: "rgba(9,27,84,0.15)",
              marginTop: 8,
            }}
          />
          <ScrollView contentContainerStyle={{ paddingTop: 12, paddingBottom: 8 }}>
            <View style={{ paddingHorizontal: 18 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text
                  style={{ flex: 1, fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: NAVY }}
                >
                  {t("leasing.renewals.sheet.title", { unit: lease.unitNumber || "—" })}
                </Text>
                <Pressable
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel={t("leasing.renewals.sheet.close")}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    backgroundColor: "rgba(9,27,84,0.06)",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ fontSize: 12, color: "#4C556F" }}>✕</Text>
                </Pressable>
              </View>
              {subParts.length > 0 ? (
                <Text style={{ fontSize: 10.5, color: MUTED, marginTop: 4, marginBottom: 6 }}>
                  {subParts.join(" · ")}
                </Text>
              ) : null}
            </View>

            {subject.currentRent !== null
              ? kvRow(
                  t("leasing.renewals.sheet.currentRent"),
                  kvValue(t("leasing.renewals.sheet.perMonth", { amount: money(subject.currentRent) })),
                )
              : null}
            {subject.marketRent !== null
              ? kvRow(
                  t("leasing.renewals.sheet.marketRent"),
                  kvValue(
                    subject.markToMarket !== null
                      ? t("leasing.renewals.sheet.marketValue", {
                          amount: money(subject.marketRent),
                          delta: signedMoney(subject.markToMarket),
                        })
                      : money(subject.marketRent),
                  ),
                )
              : null}

            {compsSentence ? (
              <View
                style={{
                  marginHorizontal: 18,
                  marginVertical: 6,
                  borderRadius: 10,
                  paddingHorizontal: 11,
                  paddingVertical: 9,
                  backgroundColor: "rgba(37,99,180,0.05)",
                  borderWidth: 1,
                  borderColor: "rgba(37,99,180,0.2)",
                }}
              >
                <Text style={{ fontSize: 10, lineHeight: 15, color: "#4C556F" }}>
                  <Text style={{ fontWeight: "800" }}>{t("leasing.renewals.sheet.compsTitle")} </Text>
                  {compsSentence}
                </Text>
              </View>
            ) : null}

            {activeOffer === null ? (
              <>
                <View style={{ paddingHorizontal: 18, paddingTop: 6 }}>
                  <Text style={{ fontSize: 10.5, color: MUTED }}>
                    {t("leasing.renewals.sheet.proposedRent")}
                  </Text>
                </View>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    marginHorizontal: 18,
                    marginVertical: 6,
                  }}
                >
                  {stepBtn("−", () => setProposed((v) => Math.max(0, v - RENT_STEP)))}
                  <Text
                    style={{
                      fontSize: 22,
                      fontWeight: "800",
                      color: NAVY,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {money(proposed)}
                  </Text>
                  {stepBtn("+", () => setProposed((v) => v + RENT_STEP))}
                  {delta !== null ? (
                    <View
                      style={{
                        marginLeft: "auto",
                        borderRadius: 999,
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        backgroundColor:
                          delta.amount > 0
                            ? "rgba(51,166,102,0.12)"
                            : delta.amount < 0
                              ? "rgba(209,56,46,0.10)"
                              : "rgba(112,120,143,0.10)",
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 10.5,
                          fontWeight: "800",
                          fontVariant: ["tabular-nums"],
                          color: delta.amount > 0 ? GOOD : delta.amount < 0 ? BAD : MUTED,
                        }}
                      >
                        {signedMoney(delta.amount)}
                        {delta.pct !== null ? ` · ${delta.pct.toFixed(1)}%` : ""}
                      </Text>
                    </View>
                  ) : null}
                </View>

                <View style={{ paddingHorizontal: 18 }}>
                  <Text style={{ fontSize: 10.5, color: MUTED }}>{t("leasing.renewals.sheet.term")}</Text>
                </View>
                <View style={{ flexDirection: "row", gap: 6, marginHorizontal: 18, marginTop: 4, marginBottom: 10 }}>
                  {termChip("12", t("leasing.renewals.sheet.term12"))}
                  {termChip("14", t("leasing.renewals.sheet.term14"))}
                  {termChip("mtm", t("leasing.renewals.sheet.termMtm"))}
                </View>

                <Pressable
                  onPress={send}
                  disabled={saving}
                  accessibilityRole="button"
                  style={{
                    marginHorizontal: 18,
                    borderRadius: 12,
                    paddingVertical: 11,
                    alignItems: "center",
                    backgroundColor: "rgba(162,169,33,0.92)",
                    opacity: saving ? 0.6 : 1,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "800", color: "#FFFFFF" }}>
                    {saving ? t("leasing.renewals.sheet.sending") : t("leasing.renewals.sheet.send")}
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                {kvRow(
                  t("leasing.renewals.sheet.recordResponse"),
                  kvValue(
                    t("leasing.renewals.sheet.offerOut", {
                      rent: money(activeOffer.proposedRent),
                      term: termLabel(activeOffer),
                      date: activeOffer.sentAt ? formatDay(Date.parse(activeOffer.sentAt)) : "—",
                    }),
                  ),
                )}
                <View style={{ flexDirection: "row", gap: 8, marginHorizontal: 18, marginTop: 4 }}>
                  <Pressable
                    onPress={() => resolve("accepted")}
                    disabled={saving}
                    accessibilityRole="button"
                    style={{
                      flex: 1,
                      borderRadius: 12,
                      paddingVertical: 11,
                      alignItems: "center",
                      backgroundColor: "rgba(51,166,102,0.9)",
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "800", color: "#FFFFFF" }}>
                      {t("leasing.renewals.sheet.markAccepted")}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => resolve("declined")}
                    disabled={saving}
                    accessibilityRole="button"
                    style={{
                      flex: 1,
                      borderRadius: 12,
                      paddingVertical: 11,
                      alignItems: "center",
                      backgroundColor: "rgba(209,56,46,0.88)",
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "800", color: "#FFFFFF" }}>
                      {t("leasing.renewals.sheet.markDeclined")}
                    </Text>
                  </Pressable>
                </View>
                <Pressable
                  onPress={() => resolve("withdrawn")}
                  disabled={saving}
                  accessibilityRole="button"
                  style={{
                    marginHorizontal: 18,
                    marginTop: 8,
                    borderRadius: 12,
                    paddingVertical: 10,
                    alignItems: "center",
                    borderWidth: 1,
                    borderColor: "rgba(9,27,84,0.15)",
                    opacity: saving ? 0.6 : 1,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "800", color: "#4C556F" }}>
                    {t("leasing.renewals.sheet.withdraw")}
                  </Text>
                </Pressable>
              </>
            )}

            {error ? (
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "600",
                  color: BAD,
                  marginTop: 10,
                  paddingHorizontal: 18,
                }}
              >
                {error}
              </Text>
            ) : null}

            <View style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 5 }}>
              <Text
                style={{
                  fontSize: 10,
                  fontWeight: "800",
                  letterSpacing: 0.8,
                  textTransform: "uppercase",
                  color: MUTED,
                }}
              >
                {t("leasing.renewals.sheet.timeline")}
              </Text>
            </View>
            {timeline.map((item) => (
              <View
                key={item.key}
                style={{
                  flexDirection: "row",
                  gap: 10,
                  paddingHorizontal: 18,
                  paddingVertical: 7,
                  borderTopWidth: 1,
                  borderTopColor: "rgba(9,27,84,0.06)",
                }}
              >
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    marginTop: 3,
                    backgroundColor: timelineDot(item),
                  }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: NAVY }}>{timelineWhat(item)}</Text>
                  {timelineSub(item) !== "" ? (
                    <Text style={{ fontSize: 9, color: MUTED, marginTop: 1 }}>{timelineSub(item)}</Text>
                  ) : null}
                </View>
              </View>
            ))}

            <Text style={{ fontSize: 10.5, color: MUTED, textAlign: "center", paddingTop: 12 }}>
              {t("leasing.renewals.sheet.acceptFoot")}
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
