import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MUTED, NAVY } from "@/theme/tokens";
import { useAccentPalette } from "@/lib/hooks/use-accent";

/**
 * Native date + time picker for the work-order journey (Scheduled, Completed).
 *
 * The two platforms want opposite things, so this is one component with two
 * shapes rather than a lowest-common-denominator of both:
 *
 *  - iOS presents the wheel INSIDE our own sheet, because since iOS 14 the
 *    picker is an inline view with no chrome of its own — it needs a host that
 *    supplies the title and the confirm/cancel buttons.
 *  - Android has its own modal dialogs and no inline mode worth using, so the
 *    sheet never renders there: opening chains the stock date dialog into the
 *    stock time dialog, which is what an Android user expects to see.
 *
 * Either way the caller sees the same thing: `onPick(ms)` or `onClear()` once,
 * or nothing if the technician backed out.
 */
export function DateTimeSheet({
  visible,
  title,
  subtitle,
  value,
  dark,
  allowClear,
  clearLabel,
  confirmLabel,
  onPick,
  onClear,
  onClose,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  /** Current value in epoch ms, or null for "unset" (the wheel opens at now). */
  value: number | null;
  dark: boolean;
  allowClear?: boolean;
  clearLabel?: string;
  confirmLabel?: string;
  onPick: (ms: number) => void;
  onClear?: () => void;
  onClose: () => void;
}) {
  const palette = useAccentPalette();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<Date>(() => new Date(value ?? Date.now()));

  // Re-seed on each open so a sheet dismissed without confirming doesn't
  // reopen holding the abandoned draft.
  const [seeded, setSeeded] = useState(false);
  if (visible && !seeded) {
    setDraft(new Date(value ?? Date.now()));
    setSeeded(true);
  } else if (!visible && seeded) {
    setSeeded(false);
  }

  // Android: drive the stock dialogs instead of rendering a sheet. Date first,
  // then time, so one "set a date" gesture produces one instant — dismissing
  // either step cancels the whole thing rather than half-committing.
  useEffect(() => {
    if (!visible || Platform.OS !== "android") return;
    const start = new Date(value ?? Date.now());
    DateTimePickerAndroid.open({
      value: start,
      mode: "date",
      onChange: (dateEvent, picked) => {
        if (dateEvent.type !== "set" || !picked) {
          onClose();
          return;
        }
        DateTimePickerAndroid.open({
          value: picked,
          mode: "time",
          onChange: (timeEvent, withTime) => {
            onClose();
            if (timeEvent.type === "set" && withTime) onPick(withTime.getTime());
          },
        });
      },
    });
    // Opening is keyed on the transition to visible; re-running on a changed
    // callback identity would stack a second dialog on top of the live one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (Platform.OS === "android") return null;

  const sheetBg = dark ? "#1C2129" : "#FCFAF4";
  const ink = dark ? "#FFFFFF" : NAVY;
  const muted = dark ? "rgba(255,255,255,0.5)" : MUTED;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(9,27,84,0.30)" }}
        onPress={onClose}
        accessibilityLabel={t("workOrders.dates.cancel")}
      />
      <View
        style={{
          backgroundColor: sheetBg,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          paddingTop: 8,
          paddingBottom: insets.bottom + 12,
        }}
      >
        <View style={{ alignItems: "center" }}>
          <View
            style={{
              width: 36,
              height: 4.5,
              borderRadius: 3,
              backgroundColor: dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.14)",
            }}
          />
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 14, gap: 3 }}>
          <Text style={{ fontSize: 17, fontWeight: "800", color: ink, letterSpacing: -0.3 }}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={{ fontSize: 12.5, fontWeight: "600", color: muted }}>{subtitle}</Text>
          ) : null}
        </View>

        <View style={{ paddingTop: 6 }}>
          <DateTimePicker
            value={draft}
            mode="datetime"
            display="spinner"
            themeVariant={dark ? "dark" : "light"}
            textColor={ink}
            onChange={(_event, picked) => {
              if (picked) setDraft(picked);
            }}
            accessibilityLabel={title}
          />
        </View>

        <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 20, paddingTop: 4 }}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            style={{
              flex: 1,
              height: 46,
              borderRadius: 999,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: dark ? "rgba(255,255,255,0.08)" : "rgba(9,27,84,0.06)",
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "700", color: ink, letterSpacing: -0.1 }}>
              {t("workOrders.dates.cancel")}
            </Text>
          </Pressable>
          {allowClear && onClear ? (
            <Pressable
              onPress={onClear}
              accessibilityRole="button"
              style={{
                flex: 1,
                height: 46,
                borderRadius: 999,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: dark ? "rgba(255,255,255,0.08)" : "rgba(9,27,84,0.06)",
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "700", color: ink, letterSpacing: -0.1 }}>
                {clearLabel ?? t("workOrders.dates.clear")}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => onPick(draft.getTime())}
            accessibilityRole="button"
            style={{
              flex: 1.35,
              height: 46,
              borderRadius: 999,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: palette.text,
            }}
          >
            <Text
              style={{ fontSize: 13, fontWeight: "700", color: "#FFFFFF", letterSpacing: -0.1 }}
            >
              {confirmLabel ?? t("workOrders.dates.set")}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
