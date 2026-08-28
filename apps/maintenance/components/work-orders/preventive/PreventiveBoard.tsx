import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PmTask, PmTaskStatus, PmTemplateRound } from "@/lib/api/pm-tasks";
import { pmDaysLate, pmDueDateMs, pmRoundOverdue } from "@/lib/derived/pm-cards";
import { abbreviatedDate } from "@/lib/derived/time";
import { HAIRLINE, MUTED, NAVY } from "@/theme/tokens";
import { useAccentPalette } from "@/lib/hooks/use-accent";

/**
 * The Preventive mode board (approved PM design pass): template round cards —
 * name, category chip, cadence, due chip, done/total progress bar — banded
 * into overdue / this round / upcoming, following the make-ready board's
 * full-bleed row + band anatomy. Tapping a round opens the unit checklist
 * sheet: one row per unit with a check circle, a skip action, and tech + date
 * attribution on completed rows.
 */

const RED = "#D1382E";
const GREEN = "#33A666";
const AMBER = "#B05E14";

const KNOWN_CADENCES = new Set(["monthly", "quarterly", "semiannual", "annual"]);

/** Localized cadence label; an unknown machine value passes through raw. */
function cadenceLabel(cadence: string, t: (key: string) => string): string {
  return KNOWN_CADENCES.has(cadence) ? t(`preventive.cadence.${cadence}`) : cadence;
}

// ── Round card bits ─────────────────────────────────────────────────────────

/** Due chip: red-filled "Nd late", green "Done" when nothing is pending,
 *  amber date otherwise; upcoming rounds (no tasks yet) carry no chip. */
function DueChip({ template, nowMs }: { template: PmTemplateRound; nowMs: number }) {
  const { t } = useTranslation();
  if (template.tasks.length === 0) return null;
  const pending = template.tasks.filter((task) => task.status === "pending").length;
  const late = pmDaysLate(template.dueDate, nowMs);

  if (late > 0 && pending > 0) {
    return (
      <View
        style={{
          paddingHorizontal: 8,
          paddingVertical: 2.5,
          borderRadius: 999,
          backgroundColor: RED,
        }}
      >
        <Text
          style={{
            fontSize: 9.5,
            fontWeight: "800",
            color: "#FFFFFF",
            fontVariant: ["tabular-nums"],
          }}
        >
          {t("preventive.chip.late", { count: late })}
        </Text>
      </View>
    );
  }
  if (pending === 0) {
    return (
      <View
        style={{
          paddingHorizontal: 8,
          paddingVertical: 2.5,
          borderRadius: 999,
          backgroundColor: `${GREEN}14`,
          borderWidth: 1,
          borderColor: `${GREEN}42`,
        }}
      >
        <Text style={{ fontSize: 9.5, fontWeight: "700", color: GREEN }}>
          {t("preventive.chip.done")}
        </Text>
      </View>
    );
  }
  const dueMs = pmDueDateMs(template.dueDate);
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2.5,
        borderRadius: 999,
        backgroundColor: `${AMBER}14`,
        borderWidth: 1,
        borderColor: `${AMBER}42`,
      }}
    >
      <Text
        style={{ fontSize: 9.5, fontWeight: "700", color: AMBER, fontVariant: ["tabular-nums"] }}
      >
        {t("preventive.chip.due", { date: abbreviatedDate(dueMs, nowMs) })}
      </Text>
    </View>
  );
}

/** Small tinted capsule for the template's category (free-text, not translated). */
function CategoryChip({ category }: { category: string }) {
  const palette = useAccentPalette();
  if (!category.trim()) return null;
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 1.5,
        borderRadius: 999,
        backgroundColor: `${palette.fill}24`,
        borderWidth: 1,
        borderColor: `${palette.fill}66`,
      }}
    >
      <Text style={{ fontSize: 9, fontWeight: "700", color: palette.text }}>{category}</Text>
    </View>
  );
}

/** Done/total progress: green fill over a faint track plus the fraction. */
function RoundProgress({ template }: { template: PmTemplateRound }) {
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const total = template.tasks.length;
  const done = template.tasks.filter((task) => task.status === "done").length;
  const skipped = template.tasks.filter((task) => task.status === "skipped").length;
  const pct = total > 0 ? (done / total) * 100 : 0;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          backgroundColor: dark ? "rgba(255,255,255,0.08)" : "rgba(9,27,84,0.07)",
          overflow: "hidden",
        }}
      >
        <View style={{ width: `${pct}%`, height: 6, borderRadius: 3, backgroundColor: GREEN }} />
      </View>
      <Text
        className="text-slate dark:text-white/70"
        style={{ fontSize: 10, fontWeight: "800", fontVariant: ["tabular-nums"] }}
      >
        {done}/{total}
      </Text>
      {skipped > 0 ? (
        <Text className="text-muted dark:text-white/50" style={{ fontSize: 9, fontWeight: "600" }}>
          {t("preventive.skippedCount", { count: skipped })}
        </Text>
      ) : null}
    </View>
  );
}

/** One template round as a full-bleed row (make-ready TurnRow anatomy). */
function RoundRow({
  template,
  nowMs,
  pad,
  onPress,
}: {
  template: PmTemplateRound;
  nowMs: number;
  pad: number;
  onPress: () => void;
}) {
  const palette = useAccentPalette();
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const upcoming = template.tasks.length === 0;
  return (
    <Pressable
      onPress={onPress}
      disabled={upcoming}
      accessibilityRole="button"
      accessibilityLabel={t("preventive.openChecklistA11y", { name: template.name })}
      style={{
        paddingHorizontal: pad,
        paddingVertical: 12,
        gap: 9,
        borderTopWidth: 1,
        borderTopColor: dark ? "rgba(255,255,255,0.10)" : HAIRLINE,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 9,
            backgroundColor: `${palette.text}21`,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="sync-outline" size={14} color={palette.text} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text
              className="text-navy dark:text-white"
              numberOfLines={1}
              style={{ flexShrink: 1, fontSize: 13.5, fontWeight: "800" }}
            >
              {template.name}
            </Text>
            <CategoryChip category={template.category} />
          </View>
          <Text
            className="text-muted dark:text-white/50"
            numberOfLines={1}
            style={{ fontSize: 9.5, fontWeight: "600" }}
          >
            {upcoming
              ? `${cadenceLabel(template.cadence, t)} · ${t("preventive.notGenerated")}`
              : `${cadenceLabel(template.cadence, t)} · ${t("preventive.unitsCount", { count: template.tasks.length })}`}
          </Text>
        </View>
        <DueChip template={template} nowMs={nowMs} />
        {!upcoming ? (
          <Ionicons
            name="chevron-forward"
            size={13}
            color={dark ? "rgba(255,255,255,0.3)" : "rgba(9,27,84,0.32)"}
          />
        ) : null}
      </View>
      {!upcoming ? <RoundProgress template={template} /> : null}
    </Pressable>
  );
}

/** Band strip, same treatment as the make-ready board's BandHeader. */
function BandHeader({ label, color, pad }: { label: string; color: string; pad: number }) {
  const dark = useColorScheme().colorScheme === "dark";
  return (
    <View
      style={{
        paddingHorizontal: pad,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: dark ? "rgba(255,255,255,0.10)" : HAIRLINE,
        backgroundColor: dark ? "rgba(255,255,255,0.04)" : "rgba(9,27,84,0.03)",
      }}
    >
      <Text style={{ fontSize: 10.5, fontWeight: "800", letterSpacing: 0.9, color }}>{label}</Text>
    </View>
  );
}

// ── Unit checklist sheet ────────────────────────────────────────────────────

/** "QH · Jul 6" attribution for a completed/skipped row. */
function attribution(task: PmTask, nowMs: number): string {
  const when = task.completedAt ? abbreviatedDate(Date.parse(task.completedAt), nowMs) : "";
  return [task.completedBy, when].filter((part) => part.length > 0).join(" · ");
}

function ChecklistRow({
  task,
  nowMs,
  onSetStatus,
}: {
  task: PmTask;
  nowMs: number;
  onSetStatus: (taskId: string, status: PmTaskStatus) => void;
}) {
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const muted = dark ? "rgba(255,255,255,0.5)" : MUTED;
  const done = task.status === "done";
  const skipped = task.status === "skipped";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 18,
        paddingVertical: 9,
        borderTopWidth: 1,
        borderTopColor: dark ? "rgba(255,255,255,0.10)" : HAIRLINE,
      }}
    >
      {/* Check circle: pending → done, done/skipped → back to pending. */}
      <Pressable
        onPress={() => onSetStatus(task.id, done || skipped ? "pending" : "done")}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={
          done || skipped
            ? t("preventive.sheet.markPendingA11y", { unit: task.unitNumber })
            : t("preventive.sheet.markDoneA11y", { unit: task.unitNumber })
        }
        hitSlop={8}
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: done
            ? GREEN
            : skipped
              ? dark
                ? "rgba(255,255,255,0.10)"
                : "rgba(9,27,84,0.08)"
              : "transparent",
          borderWidth: done ? 0 : 1.5,
          borderColor: skipped
            ? "transparent"
            : dark
              ? "rgba(255,255,255,0.28)"
              : "rgba(9,27,84,0.25)",
        }}
      >
        {done ? <Ionicons name="checkmark" size={14} color="#FFFFFF" /> : null}
        {skipped ? <Ionicons name="remove" size={14} color={muted} /> : null}
      </Pressable>

      <Text
        className={done || skipped ? "text-muted dark:text-white/50" : "text-navy dark:text-white"}
        numberOfLines={1}
        style={{
          flex: 1,
          fontSize: 13,
          fontWeight: done || skipped ? "600" : "700",
          textDecorationLine: done ? "line-through" : "none",
        }}
      >
        {task.unitNumber}
      </Text>

      {skipped ? (
        <View
          style={{
            paddingHorizontal: 7,
            paddingVertical: 1.5,
            borderRadius: 999,
            backgroundColor: "rgba(112,120,143,0.14)",
          }}
        >
          <Text style={{ fontSize: 8.5, fontWeight: "700", color: muted }}>
            {t("preventive.sheet.skipped")}
          </Text>
        </View>
      ) : null}

      {done || skipped ? (
        <Text
          className="text-muted dark:text-white/50"
          style={{ fontSize: 9.5, fontWeight: "700" }}
        >
          {attribution(task, nowMs) || "—"}
        </Text>
      ) : (
        <Pressable
          onPress={() => onSetStatus(task.id, "skipped")}
          accessibilityRole="button"
          accessibilityLabel={t("preventive.sheet.skipA11y", { unit: task.unitNumber })}
          hitSlop={6}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.16)",
          }}
        >
          <Text
            style={{
              fontSize: 10.5,
              fontWeight: "700",
              color: dark ? "rgba(255,255,255,0.72)" : "#4C556F",
            }}
          >
            {t("preventive.sheet.skip")}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/** Bottom sheet with the round's unit checklist (CloseWorkOrderSheet anatomy). */
export function UnitChecklistSheet({
  template,
  visible,
  nowMs,
  onSetStatus,
  onClose,
}: {
  template: PmTemplateRound | null;
  visible: boolean;
  nowMs: number;
  onSetStatus: (taskId: string, status: PmTaskStatus) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const ink = dark ? "#FFFFFF" : NAVY;
  const muted = dark ? "rgba(255,255,255,0.5)" : MUTED;
  const insets = useSafeAreaInsets();
  const done = template?.tasks.filter((task) => task.status === "done").length ?? 0;
  const total = template?.tasks.length ?? 0;
  const dueMs = pmDueDateMs(template?.dueDate ?? null);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(9,27,84,0.30)" }}
        onPress={onClose}
        accessibilityLabel={t("preventive.sheet.closeA11y")}
      />
      <View
        style={{
          backgroundColor: dark ? "#1C2129" : "#FCFAF4",
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          paddingTop: 8,
          paddingBottom: insets.bottom + 12,
          maxHeight: "78%",
        }}
      >
        <View
          style={{
            alignSelf: "center",
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.15)",
            marginBottom: 10,
          }}
        />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 18,
            paddingBottom: 2,
          }}
        >
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: ink }}
          >
            {template?.name ?? ""}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("preventive.sheet.closeA11y")}
            hitSlop={8}
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              backgroundColor: dark ? "rgba(255,255,255,0.08)" : "rgba(9,27,84,0.06)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="close" size={14} color={dark ? "rgba(255,255,255,0.72)" : "#4C556F"} />
          </Pressable>
        </View>
        {template ? (
          <Text style={{ paddingHorizontal: 18, paddingBottom: 10, fontSize: 10.5, color: muted }}>
            {[
              template.category.trim() || null,
              cadenceLabel(template.cadence, t),
              dueMs !== null
                ? t("preventive.chip.due", { date: abbreviatedDate(dueMs, nowMs) })
                : null,
              t("preventive.sheet.progress", { done, total }),
            ]
              .filter((part): part is string => part !== null)
              .join(" · ")}
          </Text>
        ) : null}

        <Text
          style={{
            paddingHorizontal: 18,
            paddingVertical: 6,
            fontSize: 9,
            fontWeight: "700",
            letterSpacing: 1,
            color: muted,
          }}
        >
          {t("preventive.sheet.unitsHeader", { count: total }).toUpperCase()}
        </Text>
        <ScrollView>
          {(template?.tasks ?? []).map((task) => (
            <ChecklistRow key={task.id} task={task} nowMs={nowMs} onSetStatus={onSetStatus} />
          ))}
          {total === 0 ? (
            <Text
              style={{ paddingHorizontal: 18, paddingVertical: 16, fontSize: 11.5, color: muted }}
            >
              {t("preventive.sheet.empty")}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Board ───────────────────────────────────────────────────────────────────

export function PreventiveBoard({
  templates,
  nowMs,
  pad,
  onSetStatus,
}: {
  templates: PmTemplateRound[];
  nowMs: number;
  /** Screen edge inset the full-bleed rows use for their content. */
  pad: number;
  onSetStatus: (taskId: string, status: PmTaskStatus) => void;
}) {
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const bandInk = dark ? "rgba(255,255,255,0.72)" : "#4C556F";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Resolved from props so store updates flow into the open sheet live.
  const selected = templates.find((template) => template.id === selectedId) ?? null;

  const bands = useMemo(() => {
    const overdue = templates
      .filter((template) => pmRoundOverdue(template, nowMs))
      .sort((a, b) => pmDaysLate(b.dueDate, nowMs) - pmDaysLate(a.dueDate, nowMs));
    const current = templates
      .filter((template) => template.tasks.length > 0 && !pmRoundOverdue(template, nowMs))
      .sort((a, b) => (pmDueDateMs(a.dueDate) ?? Infinity) - (pmDueDateMs(b.dueDate) ?? Infinity));
    const upcoming = templates
      .filter((template) => template.tasks.length === 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { overdue, current, upcoming };
  }, [templates, nowMs]);

  if (templates.length === 0) {
    return (
      <View style={{ alignItems: "center", paddingVertical: 48, gap: 6, paddingHorizontal: pad }}>
        <Text className="text-navy dark:text-white" style={{ fontSize: 16, fontWeight: "700" }}>
          {t("preventive.emptyTitle")}
        </Text>
        <Text
          className="text-muted dark:text-white/60"
          style={{ fontSize: 12.5, textAlign: "center" }}
        >
          {t("preventive.emptyBody")}
        </Text>
      </View>
    );
  }

  const renderRow = (template: PmTemplateRound) => (
    <RoundRow
      key={template.id}
      template={template}
      nowMs={nowMs}
      pad={pad}
      onPress={() => setSelectedId(template.id)}
    />
  );

  return (
    <View>
      {bands.overdue.length > 0 ? (
        <BandHeader
          label={t("preventive.bands.overdue", { count: bands.overdue.length })}
          color="#A32D2D"
          pad={pad}
        />
      ) : null}
      {bands.overdue.map(renderRow)}
      {bands.current.length > 0 ? (
        <BandHeader
          label={t("preventive.bands.thisRound", { count: bands.current.length })}
          color={bandInk}
          pad={pad}
        />
      ) : null}
      {bands.current.map(renderRow)}
      {bands.upcoming.length > 0 ? (
        <BandHeader
          label={t("preventive.bands.upcoming", { count: bands.upcoming.length })}
          color={bandInk}
          pad={pad}
        />
      ) : null}
      {bands.upcoming.map(renderRow)}
      <Text
        style={{
          paddingVertical: 14,
          textAlign: "center",
          fontSize: 10.5,
          color: dark ? "rgba(255,255,255,0.5)" : MUTED,
        }}
      >
        {t("preventive.footer")}
      </Text>

      <UnitChecklistSheet
        template={selected}
        visible={selected !== null}
        nowMs={nowMs}
        onSetStatus={onSetStatus}
        onClose={() => setSelectedId(null)}
      />
    </View>
  );
}
