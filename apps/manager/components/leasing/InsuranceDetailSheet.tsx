import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatDay } from "@/components/leasing/rows";
import { StatusPill, type PillTone } from "@/components/leasing/primitives";
import type { InsuranceActionKind } from "@/lib/api/insurance";
import type { InsuranceRowView, InsuranceTimelineItem } from "@/lib/derived/insurance-view";
import { parseDay } from "@/lib/derived/time";
import { activeLocale } from "@/lib/i18n";
import { MUTED, NAVY } from "@/theme/tokens";

/**
 * The compliance detail sheet — the mockup's "Compliance detail · request &
 * verify" phone, faithfully: title "<unit> · insurance" with the status
 * pill, the POLICY ON FILE facts (provider, ···last4, type, coverage, term,
 * status pill — the policy number arrives pre-masked from the server), the
 * COMPLIANCE LOG (stored actions interleaved with the derived "Lapse
 * detected" entry), the Request proof / Mark verified / Note action row, the
 * olive note explaining that "Mark verified" records who and when, and the
 * footer "Lapse detection is a date comparison — no new sync required".
 * Mount with a fresh `key` per open so state resets without effects.
 */

const BAD = "#D1382E";

/** "$100,000" — the coverage figure, full precision. */
function fullMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

/** "Apr 2, 2025" in the active locale — the policy term endpoints. */
function formatDayYear(ms: number): string {
  return new Date(ms).toLocaleDateString(activeLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "Mar 2025" in the active locale. */
function formatMonthYear(ms: number): string {
  return new Date(ms).toLocaleDateString(activeLocale(), { month: "short", year: "numeric" });
}

function statusPillOf(row: InsuranceRowView): { label: string; tone: PillTone } {
  switch (row.status) {
    case "lapsed":
      return { label: `leasing.compliance.sheet.lapsedPill`, tone: "late" };
    case "expiring":
      return { label: `leasing.compliance.sheet.expiringPill`, tone: "soon" };
    case "neverFiled":
      return { label: `leasing.compliance.sheet.neverFiledPill`, tone: "neutral" };
    case "covered":
      return { label: `leasing.compliance.sheet.coveredPill`, tone: "good" };
  }
}

const ACTION_LABEL_KEY: Record<InsuranceActionKind, string> = {
  proof_requested: "leasing.compliance.sheet.actionProofRequested",
  second_notice: "leasing.compliance.sheet.actionSecondNotice",
  verified: "leasing.compliance.sheet.actionVerified",
  note: "leasing.compliance.sheet.actionNote",
};

export function InsuranceDetailSheet({
  visible,
  row,
  bedrooms,
  classification,
  timeline,
  onClose,
  onLog,
}: {
  visible: boolean;
  row: InsuranceRowView;
  /** From the units mirror, for the "2BR Ruby" subline; null/"" = omitted. */
  bedrooms: number | null;
  classification: string;
  timeline: InsuranceTimelineItem[];
  onClose: () => void;
  /** Logs one follow-up action; resolves false on failure (sheet stays open). */
  onLog: (kind: InsuranceActionKind, note?: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  const pill = statusPillOf(row);
  const pillParams = { days: row.daysSinceLapse ?? 0, count: row.daysLeft ?? 0 };

  const subParts = [
    row.tenantName,
    [bedrooms !== null ? t("leasing.compliance.sheet.bedrooms", { count: bedrooms }) : "", classification]
      .filter(Boolean)
      .join(" "),
  ].filter(Boolean);

  const log = async (kind: InsuranceActionKind, noteText?: string): Promise<boolean> => {
    if (saving) return false;
    setError(null);
    setSaving(true);
    const ok = await onLog(kind, noteText);
    setSaving(false);
    if (!ok) setError(t("leasing.compliance.sheet.actionFailed"));
    return ok;
  };

  const saveNote = async () => {
    const trimmed = note.trim();
    if (trimmed === "") return;
    const ok = await log("note", trimmed);
    if (ok) {
      setNote("");
      setNoteOpen(false);
    }
  };

  const sect = (label: string, count?: number) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        paddingHorizontal: 18,
        paddingTop: 13,
        paddingBottom: 4,
      }}
    >
      <Text
        style={{
          fontSize: 10,
          fontWeight: "800",
          letterSpacing: 0.8,
          textTransform: "uppercase",
          color: MUTED,
        }}
      >
        {label}
      </Text>
      {count !== undefined ? (
        <View
          style={{
            borderRadius: 999,
            paddingHorizontal: 6,
            paddingVertical: 1,
            backgroundColor: "rgba(9,27,84,0.06)",
          }}
        >
          <Text style={{ fontSize: 8.5, fontWeight: "700", color: MUTED }}>{count}</Text>
        </View>
      ) : null}
    </View>
  );

  const kv = (label: string, value: React.ReactNode) => (
    <View
      style={{
        flexDirection: "row",
        paddingHorizontal: 18,
        paddingVertical: 6,
        gap: 10,
        alignItems: "baseline",
      }}
    >
      <Text style={{ fontSize: 10.5, color: MUTED, width: 96 }}>{label}</Text>
      <View style={{ flex: 1 }}>{value}</View>
    </View>
  );

  const kvText = (text: string) => (
    <Text style={{ fontSize: 11.5, fontWeight: "700", color: NAVY, fontVariant: ["tabular-nums"] }}>
      {text}
    </Text>
  );

  const startMs = parseDay(row.policy.startDate);
  const term =
    startMs !== null && row.endMs !== null
      ? `${formatDayYear(startMs)} → ${formatDayYear(row.endMs)}`
      : row.endMs !== null
        ? formatDayYear(row.endMs)
        : null;

  const timelineWhat = (item: InsuranceTimelineItem): string => {
    if (item.kind === "lapseDetected") return t("leasing.compliance.sheet.lapseDetected");
    return t(ACTION_LABEL_KEY[item.action.kind]);
  };

  const timelineSub = (item: InsuranceTimelineItem): string => {
    const date = item.whenMs !== null ? formatDay(item.whenMs) : "—";
    if (item.kind === "lapseDetected") {
      return t("leasing.compliance.sheet.lapseDetectedSub", { date });
    }
    return [
      item.action.createdBy
        ? t("leasing.compliance.sheet.actionSubBy", { date, name: item.action.createdBy })
        : date,
      item.action.note,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const timelineDot = (item: InsuranceTimelineItem): string => {
    if (item.kind === "lapseDetected") return BAD;
    switch (item.action.kind) {
      case "proof_requested":
        return "#2563B4";
      case "second_notice":
        return "#E38736";
      case "verified":
        return "#33A666";
      case "note":
        return "rgba(9,27,84,0.3)";
    }
  };

  const actBtn = (label: string, onPress: () => void, primary = false) => (
    <Pressable
      onPress={onPress}
      disabled={saving}
      accessibilityRole="button"
      style={{
        flex: 1,
        alignItems: "center",
        borderRadius: 11,
        paddingVertical: 9,
        borderWidth: 1,
        borderColor: primary ? "rgba(162,169,33,0.92)" : "rgba(9,27,84,0.12)",
        backgroundColor: primary ? "rgba(162,169,33,0.92)" : "#FFFFFF",
        opacity: saving ? 0.6 : 1,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "800", color: primary ? "#FFFFFF" : NAVY }}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(9,27,84,0.25)" }]}
        onPress={onClose}
        accessibilityLabel={t("leasing.compliance.sheet.close")}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
      >
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
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18 }}>
              <Text
                numberOfLines={1}
                style={{ flex: 1, fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: NAVY }}
              >
                {t("leasing.compliance.sheet.title", { unit: row.policy.unitNumber || "—" })}
              </Text>
              <StatusPill label={t(pill.label, pillParams)} tone={pill.tone} />
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel={t("leasing.compliance.sheet.close")}
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
              <Text style={{ paddingHorizontal: 18, fontSize: 10.5, color: MUTED, marginTop: 4 }}>
                {subParts.join(" · ")}
              </Text>
            ) : null}

            {sect(t("leasing.compliance.sheet.policySect"))}
            {row.status === "neverFiled" ? (
              <Text style={{ paddingHorizontal: 18, paddingVertical: 4, fontSize: 11.5, color: "#4C556F" }}>
                {row.leaseStartMs !== null
                  ? t("leasing.compliance.row.neverFiledSince", {
                      date: formatMonthYear(row.leaseStartMs),
                    })
                  : t("leasing.compliance.row.neverFiledNoDate")}
              </Text>
            ) : (
              <>
                {row.policy.provider
                  ? kv(t("leasing.compliance.sheet.provider"), kvText(row.policy.provider))
                  : null}
                {row.policy.policyNumberLast4
                  ? kv(
                      t("leasing.compliance.sheet.policy"),
                      kvText(`···${row.policy.policyNumberLast4}`),
                    )
                  : null}
                {row.policy.policyType
                  ? kv(t("leasing.compliance.sheet.type"), kvText(row.policy.policyType))
                  : null}
                {row.policy.coverageAmount !== null && row.policy.coverageAmount !== undefined
                  ? kv(
                      t("leasing.compliance.sheet.coverage"),
                      kvText(fullMoney(row.policy.coverageAmount)),
                    )
                  : null}
                {term !== null ? kv(t("leasing.compliance.sheet.term"), kvText(term)) : null}
                {kv(
                  t("leasing.compliance.sheet.status"),
                  <View style={{ alignSelf: "flex-start" }}>
                    <StatusPill
                      label={
                        row.status === "lapsed"
                          ? t("leasing.compliance.sheet.expiredStatus", {
                              count: row.daysSinceLapse ?? 0,
                            })
                          : row.status === "expiring"
                            ? t("leasing.compliance.sheet.expiresStatus", {
                                count: row.daysLeft ?? 0,
                              })
                            : t("leasing.compliance.sheet.activeStatus")
                      }
                      tone={row.status === "lapsed" ? "late" : row.status === "expiring" ? "soon" : "good"}
                    />
                  </View>,
                )}
              </>
            )}

            {sect(t("leasing.compliance.sheet.logSect"), timeline.length)}
            {timeline.length === 0 ? (
              <Text style={{ paddingHorizontal: 18, paddingVertical: 4, fontSize: 10.5, color: MUTED }}>
                {t("leasing.compliance.sheet.logEmpty")}
              </Text>
            ) : (
              timeline.map((item) => (
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
                    <Text style={{ fontSize: 12, fontWeight: "700", color: NAVY }}>
                      {timelineWhat(item)}
                    </Text>
                    {timelineSub(item) !== "" ? (
                      <Text style={{ fontSize: 9.5, color: MUTED, marginTop: 1 }}>
                        {timelineSub(item)}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))
            )}

            <View style={{ flexDirection: "row", gap: 7, paddingHorizontal: 18, paddingTop: 12 }}>
              {actBtn(t("leasing.compliance.sheet.requestProof"), () => void log("proof_requested"), true)}
              {actBtn(t("leasing.compliance.sheet.markVerified"), () => void log("verified"))}
              {actBtn(t("leasing.compliance.sheet.note"), () => setNoteOpen((v) => !v))}
            </View>

            {noteOpen ? (
              <View style={{ paddingHorizontal: 18, paddingTop: 8, gap: 7 }}>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  multiline
                  placeholder={t("leasing.compliance.sheet.notePlaceholder")}
                  placeholderTextColor="#9BA0B3"
                  style={{
                    borderWidth: 1,
                    borderColor: "rgba(9,27,84,0.15)",
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 9,
                    minHeight: 64,
                    fontSize: 13,
                    color: NAVY,
                    backgroundColor: "#FFFFFF",
                    textAlignVertical: "top",
                  }}
                />
                <Pressable
                  onPress={() => void saveNote()}
                  disabled={saving || note.trim() === ""}
                  accessibilityRole="button"
                  style={{
                    borderRadius: 11,
                    paddingVertical: 9,
                    alignItems: "center",
                    backgroundColor: "rgba(162,169,33,0.92)",
                    opacity: saving || note.trim() === "" ? 0.5 : 1,
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#FFFFFF" }}>
                    {t("leasing.compliance.sheet.saveNote")}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {error ? (
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "600",
                  color: BAD,
                  marginTop: 8,
                  paddingHorizontal: 18,
                }}
              >
                {error}
              </Text>
            ) : null}

            <View
              style={{
                marginHorizontal: 18,
                marginTop: 10,
                borderRadius: 10,
                paddingHorizontal: 11,
                paddingVertical: 9,
                backgroundColor: "rgba(162,169,33,0.06)",
                borderWidth: 1,
                borderColor: "rgba(162,169,33,0.3)",
              }}
            >
              <Text style={{ fontSize: 10, lineHeight: 15, color: "#4C556F" }}>
                {t("leasing.compliance.sheet.verifiedNote")}
              </Text>
            </View>

            <Text style={{ fontSize: 10.5, color: MUTED, textAlign: "center", paddingTop: 12 }}>
              {t("leasing.compliance.sheet.foot")}
            </Text>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
