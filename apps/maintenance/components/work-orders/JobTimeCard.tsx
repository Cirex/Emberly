import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  elapsedMs,
  formatDuration,
  isRunning,
  jobSummaryLine,
  type JobTimeEntry,
} from "@/lib/derived/job-time";
import { useJobTime } from "@/lib/stores/job-time";
import { HAIRLINE, MUTED, OLIVE_TEXT } from "@/theme/tokens";

const RED = "#D1382E";
const INFO = "#2563B4";

/**
 * Time and parts for one work order.
 *
 * Both are held on the device only — ResMan has no field for either until
 * closed-work-order submission exists — so this deliberately does not touch the
 * close payload. The record is stamped and kept on close instead, and shown
 * back here, so the tech can see what was captured rather than wondering
 * whether it went anywhere.
 */
export function JobTimeCard({
  workOrderId,
  closed,
  hairline,
}: {
  workOrderId: string;
  /** A closed order shows its record read-only — the clock is finished. */
  closed: boolean;
  hairline: string;
}) {
  const { t } = useTranslation();
  const entry = useJobTime((s) => s.entries[workOrderId]);
  const start = useJobTime((s) => s.start);
  const pause = useJobTime((s) => s.pause);
  const addPart = useJobTime((s) => s.addPart);
  const setPartQuantity = useJobTime((s) => s.setPartQuantity);

  const running = isRunning(entry);
  // A second-resolution display needs a second-resolution clock, but only
  // while it is actually moving.
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const [draftPart, setDraftPart] = useState("");
  const elapsed = elapsedMs(entry, running ? nowMs : Date.now());
  const parts = entry?.parts ?? [];

  if (closed) {
    const summary = jobSummaryLine(entry, Date.now());
    if (!summary) return null;
    return (
      <View style={{ gap: 6 }}>
        <Text className="text-navy dark:text-white" style={{ fontSize: 13.5, lineHeight: 19 }}>
          {summary}
        </Text>
        <Text className="text-muted dark:text-white/50" style={{ fontSize: 11 }}>
          {t("jobTime.heldOnDevice")}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      {/* Clock */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: running ? RED : "rgba(9,27,84,0.18)",
          }}
        />
        <View style={{ flex: 1 }}>
          <Text
            className="text-muted dark:text-white/50"
            style={{ fontSize: 9.5, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" }}
          >
            {t("jobTime.onThisJob")}
          </Text>
          <Text
            className="text-navy dark:text-white"
            style={{ fontSize: 27, fontWeight: "800", letterSpacing: -0.6, fontVariant: ["tabular-nums"] }}
          >
            {formatDuration(elapsed)}
          </Text>
        </View>
        <Pressable
          onPress={() => (running ? pause(workOrderId) : start(workOrderId))}
          accessibilityRole="button"
          accessibilityLabel={running ? t("jobTime.pause") : t("jobTime.start")}
          hitSlop={8}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
            paddingHorizontal: 15,
            paddingVertical: 9,
            borderRadius: 999,
            backgroundColor: running ? "rgba(209,56,46,0.10)" : "rgba(132,143,13,0.14)",
            borderWidth: 1,
            borderColor: running ? "rgba(209,56,46,0.28)" : "rgba(132,143,13,0.28)",
          }}
        >
          <Ionicons name={running ? "pause" : "play"} size={13} color={running ? RED : OLIVE_TEXT} />
          <Text style={{ fontSize: 12.5, fontWeight: "800", color: running ? RED : OLIVE_TEXT }}>
            {running ? t("jobTime.pause") : elapsed > 0 ? t("jobTime.resume") : t("jobTime.start")}
          </Text>
        </Pressable>
      </View>

      {/* Parts */}
      <View style={{ borderTopWidth: 1, borderTopColor: hairline, paddingTop: 11, gap: 2 }}>
        <Text
          className="text-muted dark:text-white/50"
          style={{ fontSize: 9.5, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}
        >
          {t("jobTime.partsUsed")}
        </Text>

        {parts.map((part) => (
          <View
            key={part.id}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 7 }}
          >
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: INFO }} />
            <Text
              className="text-navy dark:text-white"
              numberOfLines={1}
              style={{ flex: 1, fontSize: 14, fontWeight: "700" }}
            >
              {part.name}
            </Text>
            <Stepper
              quantity={part.quantity}
              onChange={(q) => setPartQuantity(workOrderId, part.id, q)}
              hairline={hairline}
            />
          </View>
        ))}

        {parts.length === 0 ? (
          <Text className="text-muted dark:text-white/50" style={{ fontSize: 12.5, paddingVertical: 4 }}>
            {t("jobTime.noParts")}
          </Text>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
          <TextInput
            value={draftPart}
            onChangeText={setDraftPart}
            placeholder={t("jobTime.addPartPlaceholder")}
            placeholderTextColor={MUTED}
            returnKeyType="done"
            onSubmitEditing={() => {
              addPart(workOrderId, draftPart);
              setDraftPart("");
            }}
            style={{
              flex: 1,
              borderWidth: 1,
              borderColor: hairline,
              borderRadius: 12,
              paddingHorizontal: 12,
              paddingVertical: 9,
              fontSize: 13.5,
            }}
            className="text-navy dark:text-white"
          />
          <Pressable
            onPress={() => {
              addPart(workOrderId, draftPart);
              setDraftPart("");
            }}
            disabled={draftPart.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel={t("jobTime.addPart")}
            style={{
              width: 40,
              height: 38,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor:
                draftPart.trim().length === 0 ? "rgba(9,27,84,0.05)" : "rgba(132,143,13,0.14)",
            }}
          >
            <Ionicons
              name="add"
              size={20}
              color={draftPart.trim().length === 0 ? MUTED : OLIVE_TEXT}
            />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** −/+ around a count; stepping below 1 removes the line, which is what a
 *  tech means by taking the last one off. */
function Stepper({
  quantity,
  onChange,
  hairline,
}: {
  quantity: number;
  onChange: (q: number) => void;
  hairline: string;
}) {
  const { t } = useTranslation();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        borderWidth: 1,
        borderColor: hairline,
        borderRadius: 999,
        overflow: "hidden",
      }}
    >
      <Pressable
        onPress={() => onChange(quantity - 1)}
        accessibilityRole="button"
        accessibilityLabel={quantity <= 1 ? t("jobTime.removePart") : t("jobTime.decrease")}
        hitSlop={6}
        style={{ paddingHorizontal: 11, paddingVertical: 5 }}
      >
        <Ionicons name={quantity <= 1 ? "trash-outline" : "remove"} size={14} color={MUTED} />
      </Pressable>
      <Text
        className="text-navy dark:text-white"
        style={{ fontSize: 13, fontWeight: "800", minWidth: 22, textAlign: "center", fontVariant: ["tabular-nums"] }}
      >
        {quantity}
      </Text>
      <Pressable
        onPress={() => onChange(quantity + 1)}
        accessibilityRole="button"
        accessibilityLabel={t("jobTime.increase")}
        hitSlop={6}
        style={{ paddingHorizontal: 11, paddingVertical: 5 }}
      >
        <Ionicons name="add" size={14} color={MUTED} />
      </Pressable>
    </View>
  );
}
