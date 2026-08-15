import { useEffect, useMemo, useState } from "react";
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
import { StatusPill } from "@/components/leasing/primitives";
import { InitialsBadge } from "@/components/ui/InitialsBadge";
import type { PipelineRow, TrackerStep } from "@/lib/derived/leasing";
import { pipelineTrackerSteps } from "@/lib/derived/leasing";
import { calendarDaysBetween, parseDay, startOfDay } from "@/lib/derived/time";
import { activeLocale } from "@/lib/i18n";
import { EMPTY_THREAD, useLeaseNotes } from "@/lib/stores/lease-notes";
import type { StaffConfig } from "@/lib/stores/config";
import { useConfig } from "@/lib/stores/config";
import { HAIRLINE, MUTED, NAVY } from "@/theme/tokens";

/**
 * The pipeline detail sheet (approved artifact, frame 02): the application's
 * whole story — dated timeline, the facts a manager reaches for (agent, rent,
 * unit readiness with its available date, term), the open make-ready work
 * holding the unit up, the shared staff notes thread, and the raw ResMan
 * strings for the day the derived stage looks wrong. Mount with a fresh `key`
 * per open so composer state resets without effects.
 */

const GOOD = "#33A666";
const TRACK_IDLE = "rgba(9,27,84,0.18)";

/** A turn work order, pre-filtered to this unit by the screen. */
export interface TurnWorkOrderItem {
  id: string;
  number: string;
  title: string;
  status: string;
  open: boolean;
}

function formatDayYear(ms: number): string {
  return new Date(ms).toLocaleDateString(activeLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "Aug 12, 9:15 AM" for note stamps. */
function formatStamp(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(activeLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "property_manager" → "Property Manager". */
function roleLabel(role: string): string {
  return role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function PipelineDetailSheet({
  visible,
  row,
  turnWorkOrders,
  config,
  nowMs,
  onClose,
}: {
  visible: boolean;
  row: PipelineRow;
  /** Make-ready tickets for this unit (open first); [] hides the section. */
  turnWorkOrders: TurnWorkOrderItem[];
  config: StaffConfig;
  nowMs: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const admin = useConfig((s) => s.admin);
  // Select the stored array itself, never `?? []` — see EMPTY_THREAD.
  const notes = useLeaseNotes((s) => s.byLease[row.lease.id]) ?? EMPTY_THREAD;
  const loadNotes = useLeaseNotes((s) => s.load);
  const postNote = useLeaseNotes((s) => s.post);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState(false);

  // The thread loads on sheet open — deliberately NOT on the sync tick.
  useEffect(() => {
    void loadNotes(config, row.lease.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.lease.id]);

  const steps = useMemo(() => pipelineTrackerSteps(row), [row]);
  const { lease } = row;

  const appliedMs = parseDay(lease.applicationDate);
  const appliedAgo =
    appliedMs !== null ? calendarDaysBetween(appliedMs, startOfDay(nowMs)) : null;
  const startMs = parseDay(lease.startDate);
  const endMs = parseDay(lease.endDate);

  const submit = async () => {
    const body = draft.trim();
    if (body === "" || posting) return;
    setPosting(true);
    setPostError(false);
    const ok = await postNote(
      config,
      { resmanLeaseId: lease.id, unitNumber: lease.unitNumber || undefined, body },
      { name: admin?.displayName ?? "", role: admin?.role ?? "" },
    );
    setPosting(false);
    if (ok) setDraft("");
    else setPostError(true);
  };

  const sect = (label: string) => (
    <Text
      style={{
        fontSize: 10,
        fontWeight: "800",
        letterSpacing: 0.8,
        textTransform: "uppercase",
        color: MUTED,
        paddingHorizontal: 18,
        paddingTop: 15,
        paddingBottom: 6,
      }}
    >
      {label}
    </Text>
  );

  const timelineTitle = (step: TrackerStep): string => t(`leasing.sheet.steps.${step.key}`);
  const timelineSub = (step: TrackerStep): string => {
    if (step.key === "approved" && (step.state === "done" || step.state === "now")) {
      return lease.approvalStatus
        ? t("leasing.sheet.approvalStatus", { status: lease.approvalStatus })
        : "";
    }
    if (step.key === "signed" && step.state === "now") return t("leasing.sheet.notSignedYet");
    if (step.key === "moveIn" && step.dateMs !== null && step.state !== "done") {
      // An application's date is the one the prospect ASKED for (ResMan holds
      // it as the lease start), not a confirmed arrival. Say which it is.
      const base = row.moveInIsDesired
        ? t("leasing.sheet.desiredMoveIn", { date: formatDay(step.dateMs) })
        : t("leasing.sheet.scheduled", { date: formatDay(step.dateMs) });
      // A date that has moved reads as firm without saying so.
      if (row.moveInSlips > 0 && row.originalMoveInMs !== null) {
        return `${base} · ${t("leasing.sheet.movedFrom", {
          count: row.moveInSlips,
          date: formatDay(row.originalMoveInMs),
        })}`;
      }
      return base;
    }
    return step.dateMs !== null ? formatDay(step.dateMs) : "";
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(9,27,84,0.25)" }]}
        onPress={onClose}
        accessibilityLabel={t("leasing.sheet.close")}
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
            maxHeight: 680,
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
            {/* Header */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 18 }}>
              <InitialsBadge name={row.tenantName || lease.unitNumber || "?"} size={38} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={{ fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: NAVY }}
                >
                  {row.tenantName || lease.unitNumber || "—"}
                </Text>
                <Text numberOfLines={1} style={{ fontSize: 11.5, color: MUTED, marginTop: 1 }}>
                  {[
                    lease.unitNumber,
                    row.classification,
                    appliedAgo !== null
                      ? t("leasing.sheet.appliedAgo", { count: appliedAgo })
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              <Pressable onPress={onClose} accessibilityRole="button" hitSlop={10}>
                <Text style={{ fontSize: 17, fontWeight: "700", color: MUTED }}>✕</Text>
              </Pressable>
            </View>

            {/* Application timeline */}
            {sect(t("leasing.sheet.timeline"))}
            <View style={{ paddingHorizontal: 18 }}>
              {steps.map((step, i) => (
                <View key={step.key} style={{ flexDirection: "row", gap: 12 }}>
                  <View style={{ alignItems: "center", width: 16 }}>
                    <View
                      style={{
                        width: 15,
                        height: 15,
                        borderRadius: 999,
                        marginTop: 2,
                        borderWidth: step.state === "done" ? 0 : 2,
                        borderStyle: step.state === "skip" ? "dashed" : "solid",
                        borderColor:
                          step.state === "now" || step.state === "skip" ? GOOD : TRACK_IDLE,
                        backgroundColor: step.state === "done" ? GOOD : "#FFFFFF",
                      }}
                    />
                    {i < steps.length - 1 ? (
                      <View
                        style={{
                          flex: 1,
                          width: 2,
                          backgroundColor: step.state === "done" ? GOOD : TRACK_IDLE,
                        }}
                      />
                    ) : null}
                  </View>
                  <View style={{ flex: 1, paddingBottom: 13 }}>
                    <Text
                      style={{
                        fontSize: 12.5,
                        fontWeight: step.state === "todo" ? "700" : "800",
                        color: step.state === "todo" ? MUTED : NAVY,
                      }}
                    >
                      {timelineTitle(step)}
                    </Text>
                    {timelineSub(step) ? (
                      <Text
                        style={{
                          fontSize: 11,
                          color: MUTED,
                          marginTop: 1,
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        {timelineSub(step)}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>

            {/* Facts */}
            {sect(t("leasing.sheet.facts"))}
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 8,
                paddingHorizontal: 18,
              }}
            >
              {[
                {
                  k: t("leasing.sheet.agent"),
                  v: lease.leasingAgent || "—",
                  sub: "",
                },
                {
                  k: t("leasing.sheet.leaseRent"),
                  v:
                    lease.residentRent !== null && lease.residentRent !== undefined
                      ? `$${Math.round(lease.residentRent).toLocaleString()}`
                      : "—",
                  sub:
                    lease.marketRent !== null && lease.marketRent !== undefined
                      ? t("leasing.sheet.marketRent", {
                          amount: `$${Math.round(lease.marketRent).toLocaleString()}`,
                        })
                      : "",
                },
                {
                  k: t("leasing.sheet.readiness"),
                  v: row.ready ? t("leasing.row.ready") : t("leasing.row.notReady"),
                  vTint: row.ready ? "#1F7A47" : "#B05E14",
                  sub:
                    !row.ready && row.dateAvailableMs !== null
                      ? t("leasing.sheet.availableOn", { date: formatDay(row.dateAvailableMs) }) +
                        (row.moveInMs !== null && row.dateAvailableMs > row.moveInMs
                          ? ` — ${t("leasing.sheet.afterMoveIn")}`
                          : "")
                      : "",
                },
                {
                  k: t("leasing.sheet.term"),
                  v:
                    startMs !== null && endMs !== null
                      ? `${formatDayYear(startMs)} → ${formatDayYear(endMs)}`
                      : "—",
                  sub: "",
                },
              ].map((fact) => (
                <View
                  key={fact.k}
                  style={{
                    flexBasis: "47%",
                    flexGrow: 1,
                    backgroundColor: "#FFFFFF",
                    borderWidth: 1,
                    borderColor: HAIRLINE,
                    borderRadius: 12,
                    paddingHorizontal: 12,
                    paddingVertical: 9,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 9,
                      fontWeight: "800",
                      letterSpacing: 0.7,
                      textTransform: "uppercase",
                      color: MUTED,
                    }}
                  >
                    {fact.k}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{
                      fontSize: 13,
                      fontWeight: "800",
                      color: (fact as { vTint?: string }).vTint ?? NAVY,
                      marginTop: 2,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {fact.v}
                  </Text>
                  {fact.sub ? (
                    <Text style={{ fontSize: 10, color: MUTED, marginTop: 1 }}>{fact.sub}</Text>
                  ) : null}
                </View>
              ))}
            </View>

            {/* Open turn work — only when the unit has tickets */}
            {turnWorkOrders.length > 0 ? (
              <>
                {sect(t("leasing.sheet.turnWork"))}
                <View style={{ paddingHorizontal: 18, gap: 6 }}>
                  {turnWorkOrders.map((wo) => (
                    <View
                      key={wo.id}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 10,
                        backgroundColor: "#FFFFFF",
                        borderWidth: 1,
                        borderColor: HAIRLINE,
                        borderRadius: 12,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 10.5,
                          fontWeight: "800",
                          color: "#2563B4",
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        {wo.number ? `WO ${wo.number}` : "WO"}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={{ flex: 1, fontSize: 11.5, fontWeight: "700", color: NAVY }}
                      >
                        {wo.title || "—"}
                      </Text>
                      <StatusPill label={wo.status || "—"} tone={wo.open ? "blue" : "good"} />
                    </View>
                  ))}
                </View>
              </>
            ) : null}

            {/* Notes thread */}
            {sect(t("leasing.sheet.notes"))}
            <View style={{ paddingHorizontal: 18 }}>
              {notes.length === 0 ? (
                <Text style={{ fontSize: 11, color: MUTED, paddingVertical: 4 }}>
                  {t("leasing.sheet.noNotes")}
                </Text>
              ) : (
                notes.map((note, i) => (
                  <View
                    key={note.id}
                    style={{
                      flexDirection: "row",
                      gap: 10,
                      paddingVertical: 8,
                      borderBottomWidth: i === notes.length - 1 ? 0 : 1,
                      borderBottomColor: HAIRLINE,
                    }}
                  >
                    <InitialsBadge name={note.createdBy || "?"} size={26} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 7 }}>
                        <Text numberOfLines={1} style={{ fontSize: 11.5, fontWeight: "800", color: NAVY }}>
                          {note.createdBy || "—"}
                          {note.createdByRole ? (
                            <Text style={{ fontWeight: "700", color: MUTED, fontSize: 10 }}>
                              {"  ·  "}
                              {roleLabel(note.createdByRole)}
                            </Text>
                          ) : null}
                        </Text>
                        <Text
                          style={{
                            marginLeft: "auto",
                            fontSize: 9.5,
                            color: MUTED,
                            fontVariant: ["tabular-nums"],
                          }}
                        >
                          {formatStamp(note.createdAt)}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 12, lineHeight: 17, color: NAVY, marginTop: 2 }}>
                        {note.body}
                      </Text>
                    </View>
                  </View>
                ))
              )}

              {/* Composer */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  marginTop: 8,
                  borderWidth: 1,
                  borderColor: "rgba(9,27,84,0.16)",
                  borderRadius: 12,
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  backgroundColor: "#FCF8F0",
                }}
              >
                <TextInput
                  value={draft}
                  onChangeText={setDraft}
                  placeholder={t("leasing.sheet.notePlaceholder")}
                  placeholderTextColor={MUTED}
                  multiline
                  style={{ flex: 1, fontSize: 12, color: NAVY, maxHeight: 90, paddingVertical: 2 }}
                />
                <Pressable
                  onPress={() => void submit()}
                  disabled={posting || draft.trim() === ""}
                  accessibilityRole="button"
                  style={{
                    borderRadius: 999,
                    paddingHorizontal: 14,
                    paddingVertical: 6,
                    backgroundColor: NAVY,
                    opacity: posting || draft.trim() === "" ? 0.45 : 1,
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#fff" }}>
                    {t("leasing.sheet.post")}
                  </Text>
                </Pressable>
              </View>
              {postError ? (
                <Text style={{ fontSize: 10.5, color: "#D1382E", marginTop: 5 }}>
                  {t("leasing.sheet.postFailed")}
                </Text>
              ) : null}
            </View>

            {/* Raw ResMan */}
            {sect(t("leasing.sheet.raw"))}
            <View style={{ paddingHorizontal: 18 }}>
              <View
                style={{
                  backgroundColor: "#FFFFFF",
                  borderWidth: 1,
                  borderColor: HAIRLINE,
                  borderRadius: 12,
                  paddingHorizontal: 12,
                  paddingVertical: 9,
                }}
              >
                <Text style={{ fontSize: 10.5, color: MUTED, fontVariant: ["tabular-nums"] }}>
                  {`status ${lease.status || "—"}  ·  approval_status ${lease.approvalStatus || "—"}  ·  signed_date ${lease.signedDate || "—"}  ·  lease_id ${lease.id}`}
                </Text>
              </View>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
