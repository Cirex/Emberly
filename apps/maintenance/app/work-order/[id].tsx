import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useColorScheme } from "nativewind";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { capture } from "@/lib/analytics";
import { CloseWorkOrderSheet } from "@/components/work-orders/CloseWorkOrderSheet";
import { MarkdownEditorSheet } from "@/components/work-orders/MarkdownEditorSheet";
import { MarkdownLite } from "@/components/work-orders/markdown";
import { TechBadge } from "@/components/work-orders/rows";
import { normalizedOccupancyFilterValue } from "@/lib/derived/filtering";
import { technicianDisplayName } from "@/lib/derived/parse";
import { workOrderStatusColor } from "@/lib/derived/status";
import { tagIconName, tagTint } from "@/lib/derived/tags";
import { abbreviatedDate, calendarDaysBetween } from "@/lib/derived/time";
import type { ParsedWorkOrder } from "@/lib/derived/types";
import { useDerivedSnapshot } from "@/lib/hooks/use-derived-snapshot";
import { useConfig } from "@/lib/stores/config";
import { useMapJump } from "@emberly/ui";
import { JobTimeCard } from "@/components/work-orders/JobTimeCard";
import { useJobTime } from "@/lib/stores/job-time";
import { usePendingCloses } from "@/lib/stores/pending-closes";
import { usePendingEdits } from "@/lib/stores/pending-edits";
import { useWorkOrderPhotos } from "@/lib/stores/work-order-photos";
import { useTranslated } from "@/lib/translation/use-translated";
import { CALLBACK_TINT, MUTED, NAVY, OLIVE, OLIVE_TEXT } from "@/theme/tokens";
import { statusLabel } from "@/lib/derived/resman-labels";

const SLATE = "#4C556F";
const RED = "#D1382E";
/** Duplicate-signal tint — kept local; distinct from the callback semantic. */
const DUPLICATE_TINT = "#7C4DBC";
const GREEN = "#1F8A4C";
const OCCUPIED_GREEN = "#33A666";

/**
 * Work-order detail in the approved flattened treatment (mockup rev of
 * 2026-07-19): a status-tinted wash over warm paper instead of the solid
 * status slab, one chip row (status + engine tags + purple signals), the
 * three date boxes fused into a connected journey line, full-bleed sections
 * split by hairlines, related orders in the Work Orders row language, and a
 * floating liquid-glass action bar (Show on Map · Mark Complete).
 */
export default function WorkOrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const dark = useColorScheme().colorScheme === "dark";
  const snapshot = useDerivedSnapshot();
  const tr = useTranslated();
  const nowMs = Date.now();
  // Which translated fields have their English original revealed.
  const [revealed, setRevealed] = useState<{ description?: boolean; notes?: boolean }>({});

  const token = useConfig((s) => s.token);
  const baseUrl = useConfig((s) => s.baseUrl);
  const pending = usePendingCloses((s) => s.pending);
  const queueClose = usePendingCloses((s) => s.queueClose);
  const pendingEdits = usePendingEdits((s) => s.pending);
  const queueEdit = usePendingEdits((s) => s.queueEdit);
  const requestJump = useMapJump((s) => s.request);

  // Which editor is up: the technician picker or one of the text editors.
  const [editing, setEditing] = useState<null | "technician" | "description" | "completionNotes">(
    null,
  );
  // Close confirmation sheet (Mark complete + optional completion photos).
  const [closeSheetOpen, setCloseSheetOpen] = useState(false);

  const wo = findWorkOrder(snapshot.byUnit, id);

  // Every technician the mirror knows, for the picker. Built from the full
  // set (not just this unit) so a reassignment can go to anyone on staff.
  const technicianOptions = useMemo(() => {
    const names = new Set<string>();
    for (const list of snapshot.byUnit.values()) {
      for (const w of list) names.add(w.technicianDisplay);
    }
    names.add("Unassigned");
    return [...names].sort((a, b) =>
      a === "Unassigned" ? -1 : b === "Unassigned" ? 1 : a.localeCompare(b),
    );
  }, [snapshot.byUnit]);

  // Record each open once per work order. No PII: the internal id + status only.
  useEffect(() => {
    if (!wo) return;
    capture("work_order_opened", { workOrderId: wo.id, status: wo.status });
    // Fire only when the opened work order changes, not on every status edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wo?.id]);

  const paper = dark ? "#14181F" : "#FAF7F0";
  const ink = dark ? "#FFFFFF" : NAVY;
  const hairline = dark ? "rgba(255,255,255,0.10)" : "rgba(9,27,84,0.08)";

  if (!wo) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: paper,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 8,
        }}
      >
        <Ionicons name="document-text-outline" size={28} color={MUTED} />
        <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "700" }}>
          Work order not found
        </Text>
        <Text
          className="text-muted dark:text-white/60"
          style={{ fontSize: 12, textAlign: "center" }}
        >
          It may not be in the cached set yet. Pull to refresh the list and try again.
        </Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          style={{
            marginTop: 8,
            paddingHorizontal: 18,
            height: 34,
            borderRadius: 999,
            backgroundColor: NAVY,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: "#FFFFFF", fontSize: 12.5, fontWeight: "600" }}>Back</Text>
        </Pressable>
      </View>
    );
  }

  // The pending-edits overlay wins over the base row until the sync absorbs
  // it (mirroring how pending closes render as closed).
  const overlay = pendingEdits[wo.id]?.patch;
  const technicianShown = technicianDisplayName(overlay?.technician ?? wo.technician);
  // A pending edit shows the tech's own typed text as-is; only the synced
  // English source is translated. Title/description/notes flow through `tr`.
  const titleTr = tr(wo.title || "");
  const descTr =
    overlay?.description !== undefined ? { shown: overlay.description, translated: false } : tr(wo.raw.notes);
  const notesTr =
    overlay?.completionNotes !== undefined
      ? { shown: overlay.completionNotes, translated: false }
      : tr(wo.raw.completion_notes);
  const descriptionShown = descTr.shown;
  const completionNotesShown = notesTr.shown;
  const anyTranslated = titleTr.translated || descTr.translated || notesTr.translated;

  const statusColor = workOrderStatusColor(wo.status);
  const facts = snapshot.unitIndex.get(wo.unitNumber);
  const occupancy = normalizedOccupancyFilterValue(facts);
  const moveInMs = facts?.moveInAt ?? facts?.leaseStartAt ?? null;
  const occupiedDays = moveInMs !== null ? calendarDaysBetween(moveInMs, nowMs) : null;

  const unitOrders = snapshot.byUnit.get(wo.unitNumber) ?? [];
  const related = unitOrders
    .filter((w) => w.id !== wo.id)
    .sort((a, b) => (b.reportedAt ?? -Infinity) - (a.reportedAt ?? -Infinity) || 0);
  const numberById = new Map(unitOrders.map((w) => [w.id, w.number]));

  const isOpen = wo.completedAt === null && !/^(completed|closed|canceled)$/i.test(wo.status);
  const pendingClose = pending[wo.id] !== undefined;
  const canClose = isOpen && !pendingClose;

  const onShowOnMap = () => {
    capture("show_on_map_used");
    if (wo.unitNumber.trim().length > 0) requestJump(wo.unitNumber.trim());
    router.push("/(tabs)/property-map");
  };
  const onMarkComplete = () => setCloseSheetOpen(true);
  const onConfirmClose = (photoUris: string[]) => {
    setCloseSheetOpen(false);
    const config = { baseUrl, token };
    const workOrderId = wo.id;
    // Queue the photos locally, then the close (which fires its own immediate
    // attempt), then kick a photo flush so the uploads ride right behind the
    // close instead of waiting a full sync tick. Any failure just leaves the
    // queues for the next tick — closing stays offline-safe.
    void (async () => {
      const photoStore = useWorkOrderPhotos.getState();
      for (const uri of photoUris) {
        try {
          await photoStore.enqueue(workOrderId, uri, "completion");
        } catch {
          // Copying the picked file failed — skip this photo, keep closing.
        }
      }
      // The clock stops and the record is stamped, not pruned: time and
      // parts have nowhere to go until closed-WO submission exists, so the
      // device holds the only copy.
      useJobTime.getState().close(workOrderId);
      await queueClose(workOrderId, "", config);
      if (photoUris.length > 0) await useWorkOrderPhotos.getState().flush(config);
    })();
    // No PII: internal work-order id + prior status category only.
    if (photoUris.length === 0) capture("completion_photo_skipped", { workOrderId });
    capture("work_order_completed", { workOrderId, status: wo.status });
    router.back();
  };

  return (
    <View style={{ flex: 1, backgroundColor: paper }}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}>
        {/* Status wash hero — the My Day wash treatment, tinted by status. */}
        {/* The route presents as a sheet, which never underlaps the status
            bar — insets.top here is dead space, so the padding is fixed. */}
        <LinearGradient
          colors={[`${statusColor}${dark ? "2E" : "1F"}`, `${statusColor}00`]}
          style={{ paddingTop: 22, paddingHorizontal: 20, paddingBottom: 2 }}
        >
          <Text
            style={{
              fontSize: 10,
              fontWeight: "700",
              letterSpacing: 1,
              color: MUTED,
              paddingRight: 44,
            }}
          >
            WORK ORDER #{wo.number}
            {wo.reportedAt !== null
              ? `  ·  REPORTED ${abbreviatedDate(wo.reportedAt, nowMs).toUpperCase()}`
              : ""}
          </Text>
          <Text
            style={{
              fontSize: 23,
              lineHeight: 27,
              fontWeight: "800",
              letterSpacing: -0.5,
              color: ink,
              marginTop: 6,
              paddingRight: 44,
            }}
          >
            {titleTr.shown || "Untitled work order"}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 7 }}>
            <Text
              style={{
                fontSize: 12.5,
                fontWeight: "600",
                color: dark ? "rgba(255,255,255,0.72)" : SLATE,
              }}
            >
              {wo.unitNumber || "—"}
            </Text>
            {occupancy ? (
              <>
                <Dot />
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: occupancy === "Occupied" ? OCCUPIED_GREEN : MUTED,
                  }}
                />
                <Text
                  style={{
                    fontSize: 12.5,
                    fontWeight: "600",
                    color: dark ? "rgba(255,255,255,0.72)" : SLATE,
                  }}
                >
                  {occupancy}
                </Text>
              </>
            ) : null}
            {occupiedDays !== null ? (
              <>
                <Dot />
                <Text style={{ fontSize: 12.5, color: MUTED }}>{occupiedDays} days</Text>
              </>
            ) : null}
          </View>

          {/* Chip row: status + engine tags + purple signals. No "Normal". */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 12,
              marginBottom: 12,
            }}
          >
            <Chip label={statusLabel(t, wo.status)} color={statusColor} emphasized />
            {wo.tags.map((t) => (
              <Chip key={t} label={t} color={tagTint(t)} icon={tagIconName(t)} />
            ))}
            {isCallback(wo) ? (
              <Chip label="Possible Callback" color={CALLBACK_TINT} icon="arrow-u-left-top" emphasized />
            ) : null}
            {wo.isDuplicate ? (
              <Chip label="Duplicate" color={DUPLICATE_TINT} icon="content-duplicate" emphasized />
            ) : null}
            {pendingClose ? (
              <Chip label="Close pending" color={OLIVE_TEXT} icon="progress-check" emphasized />
            ) : null}
            {anyTranslated ? (
              <Chip label={t("translation.badge")} color={OLIVE_TEXT} icon="translate" emphasized />
            ) : null}
          </View>
        </LinearGradient>

        {/* Floating glass close bubble */}
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={8}
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            width: 38,
            height: 38,
            borderRadius: 19,
            overflow: "hidden",
            borderWidth: 1,
            borderColor: dark ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.65)",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <BlurView
            intensity={30}
            tint={dark ? "dark" : "light"}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
          />
          <Ionicons name="close" size={17} color={dark ? "rgba(255,255,255,0.85)" : SLATE} />
        </Pressable>

        {/* Progress — the journey line. */}
        <Section
          label="Progress"
          hairline={hairline}
          first
          trailing={
            wo.completedAt !== null && wo.daysToComplete !== null ? (
              <AgePill text={`Closed in ${wo.daysToComplete} days`} color={GREEN} />
            ) : wo.reportedAt !== null && wo.completedAt === null ? (
              <AgePill
                text={`Open ${calendarDaysBetween(wo.reportedAt, nowMs)} days`}
                color={RED}
              />
            ) : null
          }
        >
          <Journey wo={wo} nowMs={nowMs} dark={dark} paper={paper} />
        </Section>

        {/* Time & parts — device-local until closed-WO submission exists. */}
        <Section label={t("jobTime.section")} hairline={hairline}>
          <JobTimeCard workOrderId={wo.id} closed={wo.completedAt !== null} hairline={hairline} />
        </Section>

        {/* Technician — tap to reassign. */}
        <Section hairline={hairline}>
          <Pressable
            onPress={() => setEditing("technician")}
            accessibilityRole="button"
            accessibilityLabel={`Reassign; currently ${technicianShown}`}
            style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
          >
            <TechBadge name={technicianShown} size={34} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{ fontSize: 13.5, fontWeight: "700", color: ink, letterSpacing: -0.1 }}
              >
                {technicianShown}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 1 }}>
                <Text
                  style={{ fontSize: 9.5, fontWeight: "700", letterSpacing: 0.8, color: MUTED }}
                >
                  ASSIGNED TECHNICIAN
                </Text>
                {overlay?.technician !== undefined ? <PendingSyncPill /> : null}
              </View>
            </View>
            <Ionicons
              name="chevron-forward"
              size={14}
              color={dark ? "rgba(255,255,255,0.3)" : "rgba(9,27,84,0.30)"}
            />
          </Pressable>
        </Section>

        {/* Description — tap to edit. */}
        <Section
          label="Description"
          hairline={hairline}
          trailing={
            overlay?.description !== undefined ? <PendingSyncPill /> : <EditGlyph dark={dark} />
          }
        >
          <Pressable onPress={() => setEditing("description")} accessibilityRole="button">
            {descriptionShown.trim().length > 0 ? (
              <MarkdownLite text={descriptionShown} ink={ink} />
            ) : (
              <Text style={{ fontSize: 12.5, color: MUTED }}>No description. Tap to add one.</Text>
            )}
          </Pressable>
          {descTr.translated ? (
            <OriginalReveal
              original={wo.raw.notes}
              revealed={revealed.description ?? false}
              onToggle={() => setRevealed((r) => ({ ...r, description: !r.description }))}
              hairline={hairline}
              t={t}
            />
          ) : null}
        </Section>

        {/* Technician notes — tap to edit. */}
        <Section
          label="Technician Notes"
          hairline={hairline}
          trailing={
            overlay?.completionNotes !== undefined ? <PendingSyncPill /> : <EditGlyph dark={dark} />
          }
        >
          <Pressable onPress={() => setEditing("completionNotes")} accessibilityRole="button">
            {completionNotesShown.trim().length > 0 ? (
              <MarkdownLite text={completionNotesShown} ink={ink} />
            ) : (
              <Text style={{ fontSize: 12.5, color: MUTED }}>
                No technician notes yet. Tap to add.
              </Text>
            )}
          </Pressable>
          {notesTr.translated ? (
            <OriginalReveal
              original={wo.raw.completion_notes}
              revealed={revealed.notes ?? false}
              onToggle={() => setRevealed((r) => ({ ...r, notes: !r.notes }))}
              hairline={hairline}
              t={t}
            />
          ) : null}
        </Section>

        {/* Related work orders */}
        <Section
          label="Related Work Orders"
          meta={related.length > 0 ? `${related.length} for this unit` : undefined}
          hairline={hairline}
          flushBody
        >
          {related.length === 0 ? (
            <Text style={{ fontSize: 12, color: MUTED, paddingHorizontal: 20 }}>
              No other work orders for this unit.
            </Text>
          ) : (
            related.slice(0, 8).map((r, i) => (
              <Pressable
                key={r.id}
                onPress={() => router.push(`/work-order/${r.id}`)}
                accessibilityRole="button"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 20,
                  paddingVertical: 9,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: dark ? "rgba(255,255,255,0.07)" : "rgba(9,27,84,0.06)",
                }}
              >
                <Text
                  style={{
                    width: 48,
                    fontSize: 11,
                    fontWeight: "800",
                    color: MUTED,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  #{r.number}
                </Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    numberOfLines={1}
                    style={{ fontSize: 12.5, fontWeight: "700", color: ink, letterSpacing: -0.1 }}
                  >
                    {tr(r.title).shown || t("workOrder.untitled")}
                  </Text>
                  {isCallback(r) && r.callbackMatchedId && numberById.has(r.callbackMatchedId) ? (
                    <View
                      style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 }}
                    >
                      <View
                        style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: CALLBACK_TINT }}
                      />
                      <Text style={{ fontSize: 10.5, fontWeight: "700", color: CALLBACK_TINT }}>
                        Possible callback → #{numberById.get(r.callbackMatchedId)}
                      </Text>
                    </View>
                  ) : (
                    <Text
                      style={{
                        fontSize: 10.5,
                        fontWeight: "700",
                        color: workOrderStatusColor(r.status),
                        marginTop: 1,
                      }}
                    >
                      {r.status}
                    </Text>
                  )}
                </View>
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: "600",
                    color: MUTED,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {abbreviatedDate(r.reportedAt, nowMs)}
                </Text>
              </Pressable>
            ))
          )}
        </Section>
      </ScrollView>

      {/* Floating liquid-glass action bar */}
      <View
        style={{
          position: "absolute",
          left: 14,
          right: 14,
          bottom: insets.bottom + 12,
          height: 56,
          borderRadius: 999,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: dark ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.55)",
          backgroundColor: dark ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.40)",
          shadowColor: "#000",
          shadowOpacity: 0.16,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 14 },
        }}
      >
        <BlurView
          intensity={dark ? 30 : 40}
          tint={dark ? "dark" : "light"}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", padding: 5, gap: 6 }}>
          <Pressable
            onPress={onShowOnMap}
            accessibilityRole="button"
            style={{
              flex: 1,
              height: "100%",
              borderRadius: 999,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
            }}
          >
            <Ionicons name="map-outline" size={15} color={ink} />
            <Text style={{ fontSize: 13, fontWeight: "700", color: ink, letterSpacing: -0.1 }}>
              Show on Map
            </Text>
          </Pressable>
          {canClose ? (
            <Pressable
              onPress={onMarkComplete}
              accessibilityRole="button"
              style={{
                flex: 1.35,
                height: "100%",
                borderRadius: 999,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                backgroundColor: OLIVE_TEXT,
                shadowColor: OLIVE_TEXT,
                shadowOpacity: 0.45,
                shadowRadius: 12,
                shadowOffset: { width: 0, height: 5 },
              }}
            >
              <Ionicons name="checkmark" size={16} color="#FFFFFF" />
              <Text
                style={{ fontSize: 13, fontWeight: "700", color: "#FFFFFF", letterSpacing: -0.1 }}
              >
                Mark Complete
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Close confirmation + completion photos */}
      <CloseWorkOrderSheet
        visible={closeSheetOpen}
        workOrderId={wo.id}
        number={wo.number}
        unitNumber={wo.unitNumber}
        dark={dark}
        onConfirm={onConfirmClose}
        onClose={() => setCloseSheetOpen(false)}
      />

      {/* Technician picker */}
      <TechnicianPicker
        visible={editing === "technician"}
        options={technicianOptions}
        current={technicianShown}
        dark={dark}
        onPick={(name) => {
          setEditing(null);
          if (name !== technicianShown)
            void queueEdit(wo.id, { technician: name }, { baseUrl, token });
        }}
        onClose={() => setEditing(null)}
      />

      {/* Description / technician-notes markdown editor */}
      <MarkdownEditorSheet
        visible={editing === "description" || editing === "completionNotes"}
        title={editing === "completionNotes" ? "Technician Notes" : "Description"}
        initialText={editing === "completionNotes" ? completionNotesShown : descriptionShown}
        dark={dark}
        paper={paper}
        ink={ink}
        allowPhotos={editing === "completionNotes"}
        workOrderId={wo.id}
        onSave={(text, photoUris) => {
          const field = editing === "completionNotes" ? "completionNotes" : "description";
          setEditing(null);
          void queueEdit(wo.id, { [field]: text }, { baseUrl, token });
          // Photos join the completion-photo queue and upload on the sync tick,
          // same path as the close flow's captures.
          for (const uri of photoUris) {
            void useWorkOrderPhotos.getState().enqueue(wo.id, uri, "completion");
          }
        }}
        onClose={() => setEditing(null)}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------

function findWorkOrder(
  byUnit: Map<string, ParsedWorkOrder[]>,
  id: string | undefined,
): ParsedWorkOrder | undefined {
  if (!id) return undefined;
  for (const list of byUnit.values()) {
    const hit = list.find((w) => w.id === id);
    if (hit) return hit;
  }
  return undefined;
}

function isCallback(wo: ParsedWorkOrder): boolean {
  return wo.callbackStatus === "possible" || wo.callbackStatus === "confirmed";
}

function Dot() {
  return <Text style={{ fontSize: 12, color: MUTED, opacity: 0.6 }}>·</Text>;
}

/** Tag/status/signal chip — same anatomy as the My Day ChipTag, sized up a
 *  touch for the hero. `emphasized` adds the tinted fill (status + signals). */
function Chip({
  label,
  color,
  icon,
  emphasized = false,
}: {
  label: string;
  color: string;
  icon?: string;
  emphasized?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4.5,
        paddingLeft: icon ? 9 : 11,
        paddingRight: 11,
        height: 26,
        borderRadius: 999,
        backgroundColor: emphasized ? `${color}14` : "rgba(255,255,255,0.55)",
        borderWidth: 1,
        borderColor: `${color}4D`,
      }}
    >
      {icon ? <MaterialCommunityIcons name={icon as never} size={12} color={color} /> : null}
      <Text style={{ fontSize: 11.5, fontWeight: "700", color, letterSpacing: -0.1 }}>{label}</Text>
    </View>
  );
}

/** Full-bleed section: hairline on top, uppercase label, 20pt gutters. */
function Section({
  label,
  meta,
  trailing,
  hairline,
  first = false,
  flushBody = false,
  children,
}: {
  label?: string;
  meta?: string;
  trailing?: React.ReactNode;
  hairline: string;
  first?: boolean;
  flushBody?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        borderTopWidth: first ? 0 : 1,
        borderTopColor: hairline,
        paddingTop: 14,
        paddingBottom: 16,
      }}
    >
      {label ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 20,
            marginBottom: 11,
          }}
        >
          <Text style={{ fontSize: 9.5, fontWeight: "800", letterSpacing: 0.9, color: MUTED }}>
            {label.toUpperCase()}
          </Text>
          {trailing ??
            (meta ? (
              <Text style={{ fontSize: 10, fontWeight: "600", color: MUTED }}>{meta}</Text>
            ) : null)}
        </View>
      ) : null}
      <View style={flushBody ? undefined : { paddingHorizontal: 20 }}>{children}</View>
    </View>
  );
}

/** Small olive marker on fields the pending-edits overlay is holding. */
function PendingSyncPill() {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: `${OLIVE_TEXT}14`,
        borderWidth: 1,
        borderColor: `${OLIVE_TEXT}38`,
      }}
    >
      <MaterialCommunityIcons name="progress-check" size={10} color={OLIVE_TEXT} />
      <Text style={{ fontSize: 9, fontWeight: "700", color: OLIVE_TEXT }}>PENDING SYNC</Text>
    </View>
  );
}

/** "View original" toggle under a translated field; expands the English source
 *  in a hairline-bordered block (mockup: on-device translation, nothing hidden). */
function OriginalReveal({
  original,
  revealed,
  onToggle,
  hairline,
  t,
}: {
  original: string;
  revealed: boolean;
  onToggle: () => void;
  hairline: string;
  t: (key: string) => string;
}) {
  return (
    <View style={{ marginTop: 9 }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        hitSlop={6}
        style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
      >
        <MaterialCommunityIcons name="translate" size={12} color={OLIVE_TEXT} />
        <Text style={{ fontSize: 11, fontWeight: "800", color: OLIVE_TEXT }}>
          {revealed ? t("translation.hideOriginal") : t("translation.viewOriginal")}
        </Text>
      </Pressable>
      {revealed ? (
        <View style={{ marginTop: 7, borderLeftWidth: 2, borderLeftColor: hairline, paddingLeft: 11 }}>
          <Text style={{ fontSize: 9, fontWeight: "800", letterSpacing: 0.8, color: MUTED }}>
            {t("translation.originalLabel").toUpperCase()}
          </Text>
          <Text style={{ fontSize: 12, color: MUTED, marginTop: 3, lineHeight: 17 }}>{original}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Quiet pencil in a section label row — the "this is editable" affordance. */
function EditGlyph({ dark }: { dark: boolean }) {
  return (
    <Ionicons
      name="create-outline"
      size={14}
      color={dark ? "rgba(255,255,255,0.35)" : "rgba(9,27,84,0.32)"}
    />
  );
}

/** Bottom-sheet list of technicians; the current one carries a checkmark. */
function TechnicianPicker({
  visible,
  options,
  current,
  dark,
  onPick,
  onClose,
}: {
  visible: boolean;
  options: string[];
  current: string;
  dark: boolean;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const sheetBg = dark ? "#1C2129" : "#FCFAF4";
  const ink = dark ? "#FFFFFF" : NAVY;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(9,27,84,0.30)" }}
        onPress={onClose}
        accessibilityLabel="Close picker"
      />
      <View
        style={{
          backgroundColor: sheetBg,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          paddingBottom: insets.bottom + 10,
          maxHeight: "62%",
        }}
      >
        <View style={{ alignItems: "center", paddingTop: 8 }}>
          <View
            style={{
              width: 36,
              height: 4.5,
              borderRadius: 3,
              backgroundColor: dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.14)",
            }}
          />
        </View>
        <Text
          style={{
            fontSize: 9.5,
            fontWeight: "800",
            letterSpacing: 0.9,
            color: MUTED,
            paddingHorizontal: 20,
            paddingTop: 12,
            paddingBottom: 6,
          }}
        >
          ASSIGN TECHNICIAN
        </Text>
        <ScrollView>
          {options.map((name) => {
            const selected = name === current;
            return (
              <Pressable
                key={name}
                onPress={() => onPick(name)}
                accessibilityRole="button"
                accessibilityState={selected ? { selected: true } : {}}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 20,
                  minHeight: 46,
                  backgroundColor: selected
                    ? dark
                      ? "rgba(255,255,255,0.06)"
                      : "rgba(132,143,13,0.08)"
                    : "transparent",
                }}
              >
                <TechBadge name={name} size={28} />
                <Text
                  numberOfLines={1}
                  style={{
                    flex: 1,
                    fontSize: 13.5,
                    fontWeight: selected ? "800" : "600",
                    color: ink,
                    letterSpacing: -0.1,
                  }}
                >
                  {name}
                </Text>
                {selected ? <Ionicons name="checkmark" size={16} color={OLIVE_TEXT} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

function AgePill({ text, color }: { text: string; color: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 9,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: `${color}14`,
        borderWidth: 1,
        borderColor: `${color}38`,
      }}
    >
      <Text style={{ fontSize: 10.5, fontWeight: "700", color }}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Journey line — Reported ● ─── Scheduled ◌ ┄┄ Completed ◌

const NODE = 16;

function Journey({
  wo,
  nowMs,
  dark,
  paper,
}: {
  wo: ParsedWorkOrder;
  nowMs: number;
  dark: boolean;
  paper: string;
}) {
  const stops: { label: string; ms: number | null; unsetText: string }[] = [
    { label: "Reported", ms: wo.reportedAt, unsetText: "—" },
    { label: "Scheduled", ms: wo.scheduledAt, unsetText: "Set date" },
    { label: "Completed", ms: wo.completedAt, unsetText: "—" },
  ];
  return (
    <View style={{ flexDirection: "row", marginTop: 2 }}>
      {stops.map((s, i) => {
        const filled = s.ms !== null;
        const last = i === stops.length - 1;
        // The segment LEAVING this node is "done" only when both ends exist.
        const segmentDone = filled && stops[i + 1]?.ms !== null;
        return (
          <View key={s.label} style={{ flex: last ? 0 : 1, minWidth: last ? 74 : undefined }}>
            <View style={{ flexDirection: "row", alignItems: "center", height: NODE }}>
              <View
                style={{
                  width: NODE,
                  height: NODE,
                  borderRadius: NODE / 2,
                  backgroundColor: filled ? OLIVE : paper,
                  borderWidth: filled ? 0 : 2,
                  borderColor: dark ? "rgba(255,255,255,0.28)" : "rgba(9,27,84,0.28)",
                  borderStyle: filled ? "solid" : "dashed",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {filled ? (
                  <View
                    style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#FFFFFF" }}
                  />
                ) : null}
              </View>
              {!last ? (
                segmentDone ? (
                  <View
                    style={{
                      flex: 1,
                      height: 2,
                      borderRadius: 1,
                      backgroundColor: OLIVE,
                      marginHorizontal: 4,
                    }}
                  />
                ) : (
                  // Uniform border on a zero-height view — single-edge dashed
                  // borders are unsupported on the new arch (native warning,
                  // nothing drawn).
                  <View
                    style={{
                      flex: 1,
                      height: 0,
                      borderWidth: 1,
                      borderStyle: "dashed",
                      borderColor: dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.18)",
                      marginHorizontal: 4,
                    }}
                  />
                )
              ) : null}
            </View>
            <Text
              style={{
                fontSize: 9,
                fontWeight: "800",
                letterSpacing: 0.7,
                color: MUTED,
                marginTop: 8,
              }}
            >
              {s.label.toUpperCase()}
            </Text>
            <Text
              style={{
                fontSize: 12.5,
                fontWeight: filled ? "700" : "600",
                color: filled ? (dark ? "#FFFFFF" : NAVY) : MUTED,
                marginTop: 2,
                fontVariant: ["tabular-nums"],
              }}
            >
              {filled ? abbreviatedDate(s.ms, nowMs) : s.unsetText}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
