import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { memo, useState } from "react";
import { Image, Modal, Pressable, Text, View } from "react-native";
import { ACCENT_THEMES, HAIRLINE, MUTED, NAVY, type AccentThemeId } from "@/theme/tokens";

/**
 * The Appearance controls, per the approved design pass.
 *
 * Theme was three words in a segmented control; it is now three miniatures, so
 * the choice is made by looking rather than by reading. Accent shows the Emberly
 * mark beside the swatches and recolours it live — a setting that demonstrates
 * itself. Language is a dropdown listing each language IN that language, which
 * is how a Spanish speaker finds Spanish.
 */

const FLOWER = require("@/assets/logo-flower.png");

export type ThemeChoice = "system" | "light" | "dark";

/* ------------------------------------------------------------------ theme */

/** The little screen inside a theme card: a title bar and three text lines. */
function Miniature({ choice, accent }: { choice: ThemeChoice; accent: string }) {
  const light = { bg: "#FCF8F0", bar: "rgba(9,27,84,0.22)" };
  const dark = { bg: "#141B33", bar: "rgba(255,255,255,0.28)" };
  const half = choice === "system";
  const left = choice === "dark" ? dark : light;
  const right = choice === "light" ? light : dark;

  const Line = ({ top, inset }: { top: number; inset: number }) => (
    <View
      style={{
        position: "absolute",
        left: 7,
        right: 7 + inset,
        top,
        height: 4,
        flexDirection: "row",
      }}
    >
      <View style={{ flex: 1, backgroundColor: left.bar, borderRadius: 2 }} />
      {half ? (
        <View style={{ flex: 1, backgroundColor: right.bar, borderRadius: 2, marginLeft: 1 }} />
      ) : null}
    </View>
  );

  return (
    <View
      style={{ height: 56, borderTopLeftRadius: 11, borderTopRightRadius: 11, overflow: "hidden" }}
    >
      <View style={{ ...StyleSheetAbsolute, flexDirection: "row" }}>
        <View style={{ flex: 1, backgroundColor: left.bg }} />
        {half ? <View style={{ flex: 1, backgroundColor: right.bg }} /> : null}
      </View>
      {/* The title bar carries the accent, so each card previews both choices. */}
      <View
        style={{
          position: "absolute",
          left: 7,
          right: 7,
          top: 9,
          height: 6,
          borderRadius: 3,
          backgroundColor: accent,
        }}
      />
      <Line top={21} inset={16} />
      <Line top={31} inset={8} />
      <Line top={41} inset={24} />
    </View>
  );
}

const StyleSheetAbsolute = { position: "absolute" as const, top: 0, bottom: 0, left: 0, right: 0 };

export const ThemeCards = memo(function ThemeCards({
  value,
  options,
  accent,
  onChange,
}: {
  value: ThemeChoice;
  options: { id: ThemeChoice; label: string }[];
  accent: string;
  onChange: (v: ThemeChoice) => void;
}) {
  const darkScheme = useColorScheme().colorScheme === "dark";
  return (
    <View style={{ flexDirection: "row", gap: 9, paddingVertical: 4 }}>
      {options.map((o) => {
        const on = value === o.id;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            accessibilityRole="button"
            accessibilityState={on ? { selected: true } : {}}
            accessibilityLabel={o.label}
            style={{
              flex: 1,
              borderRadius: 13,
              borderWidth: 1.5,
              borderColor: on ? accent : darkScheme ? "rgba(255,255,255,0.10)" : HAIRLINE,
              backgroundColor: darkScheme ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.55)",
              overflow: "hidden",
            }}
          >
            <Miniature choice={o.id} accent={accent} />
            <View
              style={{
                paddingVertical: 7,
                borderTopWidth: 1,
                borderTopColor: darkScheme ? "rgba(255,255,255,0.10)" : HAIRLINE,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "700",
                  textAlign: "center",
                  color: on ? accent : darkScheme ? "rgba(255,255,255,0.5)" : MUTED,
                }}
              >
                {o.label}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
});

/* ----------------------------------------------------------------- accent */

const ACCENT_IDS = Object.keys(ACCENT_THEMES) as AccentThemeId[];

export const AccentPicker = memo(function AccentPicker({
  value,
  onChange,
}: {
  value: AccentThemeId;
  onChange: (id: AccentThemeId) => void;
}) {
  const theme = ACCENT_THEMES[value] ?? ACCENT_THEMES.olive;
  const dark = useColorScheme().colorScheme === "dark";
  return (
    <View style={{ paddingVertical: 6, gap: 13 }}>
      {/* The mark IS the preview: the setting shows its own effect. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 11 }}>
        <Image
          source={FLOWER}
          tintColor={theme.hex}
          style={{ width: 34, height: 34 }}
          resizeMode="contain"
        />
        <View>
          <Text className="text-navy dark:text-white" style={{ fontSize: 12.5, fontWeight: "700" }}>
            {theme.label}
          </Text>
          <Text style={{ fontSize: 10.5, color: dark ? "rgba(255,255,255,0.5)" : MUTED }}>
            Tints the mark, tabs, and selection
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
        {ACCENT_IDS.map((id) => {
          const on = value === id;
          return (
            <Pressable
              key={id}
              onPress={() => onChange(id)}
              accessibilityRole="button"
              accessibilityLabel={ACCENT_THEMES[id].label}
              accessibilityState={on ? { selected: true } : {}}
              style={{
                width: 32,
                height: 32,
                borderRadius: 10,
                backgroundColor: ACCENT_THEMES[id].hex,
                borderWidth: on ? 2.5 : 1,
                borderColor: on ? (dark ? "#FFFFFF" : NAVY) : "rgba(0,0,0,0.10)",
              }}
            />
          );
        })}
      </View>
    </View>
  );
});

/* --------------------------------------------------------------- dropdown */

export function Dropdown<T extends string>({
  value,
  options,
  accent,
  onChange,
}: {
  value: T;
  /** `label` is the name in its OWN language; `hint` names it in the UI's. */
  options: { id: T; label: string; hint?: string }[];
  accent: string;
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value) ?? options[0];
  const dark = useColorScheme().colorScheme === "dark";
  const ink = dark ? "#FFFFFF" : NAVY;
  const muted = dark ? "rgba(255,255,255,0.5)" : MUTED;
  const hairline = dark ? "rgba(255,255,255,0.10)" : HAIRLINE;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={current?.label}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          paddingHorizontal: 11,
          paddingVertical: 7,
          borderRadius: 11,
          borderWidth: 1,
          borderColor: dark ? "rgba(255,255,255,0.18)" : "rgba(9,27,84,0.16)",
        }}
      >
        <Text className="text-navy dark:text-white" style={{ fontSize: 13, fontWeight: "600" }}>
          {current?.label}
        </Text>
        <Ionicons name="chevron-down" size={13} color={muted} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          onPress={() => setOpen(false)}
          style={{
            flex: 1,
            backgroundColor: "rgba(9,27,84,0.28)",
            alignItems: "center",
            justifyContent: "center",
            padding: 28,
          }}
        >
          <View
            style={{
              width: "100%",
              maxWidth: 340,
              borderRadius: 18,
              backgroundColor: dark ? "#1B1D20" : "rgba(252,250,244,0.99)",
              overflow: "hidden",
              borderWidth: 1,
              borderColor: dark ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.6)",
            }}
          >
            {options.map((o, i) => {
              const on = o.id === value;
              return (
                <Pressable
                  key={o.id}
                  onPress={() => {
                    setOpen(false);
                    if (!on) onChange(o.id);
                  }}
                  accessibilityRole="button"
                  accessibilityState={on ? { selected: true } : {}}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingHorizontal: 18,
                    paddingVertical: 14,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: hairline,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                    <Text style={{ fontSize: 14.5, fontWeight: on ? "700" : "500", color: ink }}>
                      {o.label}
                    </Text>
                    {o.hint ? <Text style={{ fontSize: 11, color: muted }}>{o.hint}</Text> : null}
                  </View>
                  {on ? <Ionicons name="checkmark" size={17} color={accent} /> : null}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
