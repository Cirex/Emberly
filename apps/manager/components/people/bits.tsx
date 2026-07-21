import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { initialsOf } from "@/components/people/format";

/**
 * Visual atoms for the People directory and the tenant profile, ported 1:1
 * from the approved mockup (manager-people-insurance.html): pills, lead
 * avatars, band headers, scope chips, section labels, key/value rows with the
 * masked + reveal affordance, mini cards, and the phone sheet chrome.
 *
 * Everything is Views and Texts — no chart or gradient dependencies.
 */

export const PEOPLE_COLORS = {
  navy: "#091B54",
  slate: "#4C556F",
  muted: "#70788F",
  faint: "#9BA0B3",
  olive: "#767B24",
  pos: "#33A666",
  warn: "#B05E14",
  bad: "#D1382E",
  deepRed: "#A32D2D",
  info: "#2563B4",
  purple: "#7A6BC7",
} as const;

export type PillTone = "ok" | "good" | "soon" | "late" | "neutral" | "review" | "blue";

const PILL_STYLES: Record<PillTone, { color: string; bg: string; border: string }> = {
  ok: { color: "#767B24", bg: "rgba(162,169,33,0.12)", border: "rgba(162,169,33,0.35)" },
  good: { color: "#33A666", bg: "rgba(51,166,102,0.09)", border: "rgba(51,166,102,0.3)" },
  soon: { color: "#B05E14", bg: "rgba(176,94,20,0.08)", border: "rgba(176,94,20,0.3)" },
  late: { color: "#FFFFFF", bg: "#D1382E", border: "#A32D2D" },
  neutral: { color: "#70788F", bg: "rgba(112,120,143,0.07)", border: "rgba(112,120,143,0.25)" },
  review: { color: "#7A6BC7", bg: "rgba(122,107,199,0.08)", border: "rgba(122,107,199,0.3)" },
  blue: { color: "#2563B4", bg: "rgba(37,99,180,0.08)", border: "rgba(37,99,180,0.3)" },
};

export function Pill({ tone, label }: { tone: PillTone; label: string }) {
  const s = PILL_STYLES[tone];
  return (
    <View
      style={{
        alignSelf: "flex-start",
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderWidth: 1,
        backgroundColor: s.bg,
        borderColor: s.border,
      }}
    >
      <Text style={{ fontSize: 9, fontWeight: "800", color: s.color }}>{label}</Text>
    </View>
  );
}

/** The mockup's five `.lead` avatar tints, picked by a hash of the name. */
const LEAD_PALETTES = [
  { color: "#767B24", bg: "rgba(162,169,33,0.14)", border: "rgba(162,169,33,0.35)" },
  { color: "#2563B4", bg: "rgba(37,99,180,0.10)", border: "rgba(37,99,180,0.28)" },
  { color: "#0E7D7D", bg: "rgba(14,125,125,0.10)", border: "rgba(14,125,125,0.28)" },
  { color: "#9C4DCC", bg: "rgba(156,77,204,0.10)", border: "rgba(156,77,204,0.28)" },
  { color: "#A32D2D", bg: "rgba(163,45,45,0.10)", border: "rgba(163,45,45,0.28)" },
];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Circular initials avatar with a stable per-name tint (mockup `.lead`). */
export function Lead({ name, size = 30, glyph }: { name: string; size?: number; glyph?: string }) {
  const palette = LEAD_PALETTES[hashName(name) % LEAD_PALETTES.length];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: palette.bg,
        borderWidth: 1,
        borderColor: palette.border,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: size * 0.35, fontWeight: "800", color: palette.color }}>
        {glyph ?? initialsOf(name)}
      </Text>
    </View>
  );
}

/** Uppercase band header over a result group ("PEOPLE"). */
export function BandHeader({ label }: { label: string }) {
  return (
    <Text
      style={{
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 5,
        fontSize: 10,
        fontWeight: "700",
        letterSpacing: 1,
        textTransform: "uppercase",
        color: PEOPLE_COLORS.muted,
      }}
    >
      {label}
    </Text>
  );
}

/** Scope chip ("All · 4"), active in olive. */
export function ScopeChip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count?: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={active ? { selected: true } : {}}
      style={{
        borderRadius: 999,
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderWidth: 1,
        backgroundColor: active ? "rgba(162,169,33,0.14)" : "rgba(9,27,84,0.04)",
        borderColor: active ? "rgba(162,169,33,0.45)" : "rgba(9,27,84,0.1)",
      }}
    >
      <Text
        style={{
          fontSize: 10,
          fontWeight: "700",
          color: active ? PEOPLE_COLORS.olive : PEOPLE_COLORS.muted,
        }}
      >
        {count === undefined ? label : `${label} · ${count}`}
      </Text>
    </Pressable>
  );
}

/** One tappable list row: lead · title/subtitle · right rail. */
export function Row({
  lead,
  title,
  subtitle,
  right,
  selected,
  onPress,
}: {
  lead?: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  selected?: boolean;
  onPress?: () => void;
}) {
  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        paddingHorizontal: 16,
        paddingVertical: 11,
        borderTopWidth: 1,
        borderTopColor: "rgba(9,27,84,0.08)",
        backgroundColor: selected ? "rgba(162,169,33,0.07)" : "transparent",
      }}
    >
      {lead}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ fontSize: 13.5, fontWeight: "800", color: PEOPLE_COLORS.navy }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            style={{ fontSize: 9.5, fontWeight: "600", color: PEOPLE_COLORS.muted, marginTop: 1 }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={{ alignItems: "flex-end", gap: 2 }}>{right}</View> : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
      {body}
    </Pressable>
  );
}

/** Small-caps section label with an optional count lozenge. */
export function SectionLabel({ label, count }: { label: string; count?: string | number }) {
  return (
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
          fontSize: 9.5,
          fontWeight: "800",
          letterSpacing: 1,
          textTransform: "uppercase",
          color: PEOPLE_COLORS.faint,
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
          <Text style={{ fontSize: 8.5, color: PEOPLE_COLORS.muted }}>{count}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Key/value line. `masked` renders the dotted placeholder + reveal affordance. */
export function KeyValue({
  label,
  value,
  masked,
  maskedPlaceholder,
  revealLabel,
  onReveal,
  trailing,
}: {
  label: string;
  value?: string;
  masked?: boolean;
  maskedPlaceholder?: string;
  revealLabel?: string;
  onReveal?: () => void;
  trailing?: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 18,
        paddingVertical: 6,
      }}
    >
      <Text style={{ fontSize: 10.5, color: PEOPLE_COLORS.muted, width: 108 }}>{label}</Text>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}>
        {masked ? (
          <>
            <Text
              style={{
                fontSize: 11.5,
                fontWeight: "600",
                letterSpacing: 1,
                color: PEOPLE_COLORS.faint,
              }}
            >
              {maskedPlaceholder ?? "•••••••••"}
            </Text>
            {onReveal ? (
              <Pressable
                onPress={onReveal}
                accessibilityRole="button"
                accessibilityLabel={`${revealLabel ?? "reveal"} ${label}`}
                hitSlop={8}
                style={{
                  borderRadius: 6,
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: "rgba(118,123,36,0.5)",
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                }}
              >
                <Text style={{ fontSize: 9, fontWeight: "800", color: PEOPLE_COLORS.olive }}>
                  {revealLabel ?? "reveal"}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : (
          <Text style={{ fontSize: 11.5, fontWeight: "700", color: PEOPLE_COLORS.navy }}>
            {value ?? "—"}
          </Text>
        )}
        {trailing}
      </View>
    </View>
  );
}

/** White card with a title row and a caption line (mockup `.minicard`). */
export function MiniCard({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "plain" | "warn" | "bad";
}) {
  const border =
    tone === "warn"
      ? "rgba(176,94,20,0.35)"
      : tone === "bad"
        ? "rgba(209,56,46,0.35)"
        : "rgba(9,27,84,0.09)";
  const bg =
    tone === "warn"
      ? "rgba(176,94,20,0.04)"
      : tone === "bad"
        ? "rgba(209,56,46,0.04)"
        : "#FFFFFF";
  return (
    <View
      style={{
        marginHorizontal: 18,
        marginTop: 4,
        marginBottom: 6,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: border,
        backgroundColor: bg,
        paddingHorizontal: 11,
        paddingVertical: 9,
      }}
    >
      {children}
    </View>
  );
}

/** Monospaced plate chip ("TN · 7REY220"). */
export function PlateChip({ plate, state }: { plate: string; state: string }) {
  return (
    <View
      style={{
        borderRadius: 5,
        borderWidth: 1,
        borderColor: "rgba(9,27,84,0.14)",
        backgroundColor: "rgba(9,27,84,0.05)",
        paddingHorizontal: 7,
        paddingVertical: 2,
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: "800",
          letterSpacing: 0.5,
          color: PEOPLE_COLORS.navy,
          fontVariant: ["tabular-nums"],
        }}
      >
        {state ? `${state} · ${plate}` : plate}
      </Text>
    </View>
  );
}

/** One action button in the Call / Message / Email / Ledger row. */
export function ActionButton({
  label,
  primary,
  disabled,
  onPress,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={disabled ? { disabled: true } : {}}
      style={{
        flex: 1,
        borderRadius: 11,
        paddingVertical: 8,
        paddingHorizontal: 6,
        alignItems: "center",
        borderWidth: 1,
        opacity: disabled ? 0.4 : 1,
        backgroundColor: primary ? "rgba(162,169,33,0.92)" : "#FFFFFF",
        borderColor: primary ? "rgba(162,169,33,0.92)" : "rgba(9,27,84,0.12)",
      }}
    >
      <Text
        numberOfLines={1}
        style={{ fontSize: 11, fontWeight: "800", color: primary ? "#FFFFFF" : PEOPLE_COLORS.navy }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Three-cell metric strip (balance · net position · insurance countdown). */
export function MetricStrip({
  metrics,
}: {
  metrics: { value: string; tint?: string; label: string; caption?: string }[];
}) {
  return (
    <View style={{ flexDirection: "row", paddingHorizontal: 18, paddingTop: 4, paddingBottom: 6 }}>
      {metrics.map((m, i) => (
        <View
          key={`${m.label}-${i}`}
          style={{
            flex: 1,
            paddingLeft: i === 0 ? 0 : 14,
            borderLeftWidth: i === 0 ? 0 : 1,
            borderLeftColor: "rgba(9,27,84,0.08)",
          }}
        >
          <Text
            style={{
              fontSize: 24,
              fontWeight: "800",
              letterSpacing: -0.5,
              color: m.tint ?? PEOPLE_COLORS.navy,
              fontVariant: ["tabular-nums"],
            }}
          >
            {m.value}
          </Text>
          <Text numberOfLines={1} style={{ fontSize: 10, fontWeight: "600", color: PEOPLE_COLORS.slate, marginTop: 2 }}>
            {m.label}
          </Text>
          {m.caption ? (
            <Text numberOfLines={1} style={{ fontSize: 9, color: PEOPLE_COLORS.muted, marginTop: 1 }}>
              {m.caption}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** Tinted explanatory note (the mockup's PII callout). */
export function NoteBox({ children }: { children: string }) {
  return (
    <View
      style={{
        marginHorizontal: 18,
        marginTop: 8,
        marginBottom: 2,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: "rgba(122,107,199,0.22)",
        backgroundColor: "rgba(122,107,199,0.06)",
        paddingHorizontal: 10,
        paddingVertical: 8,
      }}
    >
      <Text style={{ fontSize: 9.5, lineHeight: 14, color: PEOPLE_COLORS.slate }}>{children}</Text>
    </View>
  );
}

/** Centered muted footer line. */
export function ListFooter({ children }: { children: string }) {
  return (
    <Text
      style={{
        paddingHorizontal: 16,
        paddingVertical: 14,
        textAlign: "center",
        fontSize: 10.5,
        color: PEOPLE_COLORS.muted,
      }}
    >
      {children}
    </Text>
  );
}

/**
 * Phone bottom-sheet chrome for the tenant profile: grabber, avatar + name
 * header, close button, subline, scrollable body. On iPad (>=1040) the screen
 * renders the same body in the split's right pane instead.
 */
export function ProfileSheet({
  visible,
  onClose,
  name,
  subtitle,
  closeLabel,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  name: string;
  subtitle?: string;
  closeLabel: string;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(9,27,84,0.25)" }]}
        onPress={onClose}
        accessibilityLabel={closeLabel}
      />
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: "90%",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          backgroundColor: "rgba(250,247,240,0.99)",
          shadowColor: PEOPLE_COLORS.navy,
          shadowOpacity: 0.12,
          shadowRadius: 30,
          shadowOffset: { width: 0, height: -8 },
          paddingBottom: Math.max(insets.bottom, 16),
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
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingHorizontal: 18,
            paddingTop: 12,
          }}
        >
          <Lead name={name} size={38} />
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: PEOPLE_COLORS.navy }}
          >
            {name}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
            hitSlop={8}
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              backgroundColor: "rgba(9,27,84,0.06)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="close" size={14} color={PEOPLE_COLORS.slate} />
          </Pressable>
        </View>
        {subtitle ? (
          <Text style={{ paddingHorizontal: 18, paddingTop: 4, fontSize: 10.5, color: PEOPLE_COLORS.muted }}>
            {subtitle}
          </Text>
        ) : null}
        <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>{children}</ScrollView>
      </View>
    </Modal>
  );
}
