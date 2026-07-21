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
import { MONEY_COLORS, QuickChip } from "@/components/delinquency/bits";
import {
  DELINQUENCY_ACTION_KINDS,
  PROMISE_DATED_KINDS,
  type DelinquencyActionKind,
} from "@/lib/api/delinquency";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface LogActionDraft {
  kind: DelinquencyActionKind;
  note?: string;
  amount?: number;
  promiseDueDate?: string;
}

/**
 * The Log action / Record promise form: kind picker chips, note, optional
 * amount, and a due-date field that appears only for promise-dated kinds.
 * Mount with a fresh `key` per open so state resets without effects. The
 * submit handler resolves false on failure — the sheet stays open with the
 * draft intact and shows the error line.
 */
export function LogActionSheet({
  visible,
  initialKind,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  initialKind: DelinquencyActionKind;
  onClose: () => void;
  onSubmit: (draft: LogActionDraft) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [kind, setKind] = useState<DelinquencyActionKind>(initialKind);
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPromise = PROMISE_DATED_KINDS.has(kind);
  const promiseFlavor = PROMISE_DATED_KINDS.has(initialKind);

  const submit = async () => {
    if (saving) return;
    const trimmedDate = dueDate.trim();
    if (isPromise && trimmedDate !== "" && !DATE_RE.test(trimmedDate)) {
      setError(t("delinquency.actionSheet.invalidDate"));
      return;
    }
    const parsedAmount = Number(amount.replace(/[$,\s]/g, ""));
    setError(null);
    setSaving(true);
    const ok = await onSubmit({
      kind,
      note: note.trim() || undefined,
      amount: amount.trim() !== "" && Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : undefined,
      promiseDueDate: isPromise && trimmedDate !== "" ? trimmedDate : undefined,
    });
    setSaving(false);
    if (ok) onClose();
    else setError(t("delinquency.actionSheet.failed"));
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: "rgba(9,27,84,0.15)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
    color: MONEY_COLORS.navy,
    backgroundColor: "#FFFFFF",
  } as const;

  const label = (text: string) => (
    <Text style={{ fontSize: 10, fontWeight: "700", color: MONEY_COLORS.slate, marginTop: 12, marginBottom: 5 }}>
      {text}
    </Text>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(9,27,84,0.25)" }]}
        onPress={onClose}
        accessibilityLabel={t("delinquency.actionSheet.cancel")}
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
            maxHeight: 560,
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
          <ScrollView
            contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 12 }}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={{ fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: MONEY_COLORS.navy }}>
              {promiseFlavor ? t("delinquency.actionSheet.promiseTitle") : t("delinquency.actionSheet.title")}
            </Text>

            {label(t("delinquency.actionSheet.kind"))}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {DELINQUENCY_ACTION_KINDS.map((k) => (
                <QuickChip
                  key={k}
                  label={t(`delinquency.kinds.${k}`)}
                  active={kind === k}
                  onPress={() => setKind(k)}
                />
              ))}
            </View>

            {label(t("delinquency.actionSheet.note"))}
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder={t("delinquency.actionSheet.notePlaceholder")}
              placeholderTextColor={MONEY_COLORS.muted}
              multiline
              style={[inputStyle, { minHeight: 60 }]}
            />

            {label(t("delinquency.actionSheet.amount"))}
            <TextInput
              value={amount}
              onChangeText={setAmount}
              placeholder="$0"
              placeholderTextColor={MONEY_COLORS.muted}
              keyboardType="decimal-pad"
              style={inputStyle}
            />

            {isPromise ? (
              <>
                {label(t("delinquency.actionSheet.dueDate"))}
                <TextInput
                  value={dueDate}
                  onChangeText={setDueDate}
                  placeholder={t("delinquency.actionSheet.dueDatePlaceholder")}
                  placeholderTextColor={MONEY_COLORS.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={inputStyle}
                />
              </>
            ) : null}

            {error ? (
              <Text style={{ fontSize: 11, fontWeight: "600", color: MONEY_COLORS.bad, marginTop: 10 }}>{error}</Text>
            ) : null}

            <View style={{ flexDirection: "row", gap: 8, marginTop: 16 }}>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                style={{
                  flex: 1,
                  borderRadius: 12,
                  paddingVertical: 11,
                  alignItems: "center",
                  borderWidth: 1,
                  borderColor: "rgba(9,27,84,0.15)",
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: MONEY_COLORS.slate }}>
                  {t("delinquency.actionSheet.cancel")}
                </Text>
              </Pressable>
              <Pressable
                onPress={submit}
                disabled={saving}
                accessibilityRole="button"
                style={{
                  flex: 1,
                  borderRadius: 12,
                  paddingVertical: 11,
                  alignItems: "center",
                  backgroundColor: "rgba(162,169,33,0.92)",
                  opacity: saving ? 0.6 : 1,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#FFFFFF" }}>
                  {saving ? t("delinquency.actionSheet.saving") : t("delinquency.actionSheet.save")}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
