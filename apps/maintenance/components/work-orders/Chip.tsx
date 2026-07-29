import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { Pressable, Text, View } from "react-native";
import { useAccentPalette } from "@/lib/hooks/use-accent";


/**
 * A small glass action chip — an icon (optionally with a label) and an
 * optional count badge. Used as the Filters funnel on the Work Orders header;
 * lifts to the accent when active.
 *
 * The idle state was a white pill with a navy border — correct on paper, a lit
 * dot on the dark header it sits in. Both states pair now.
 */
export function Chip({
  label,
  icon,
  active,
  badge,
  onPress,
  tint,
  activeTint,
  accessibilityLabel,
}: {
  label?: string;
  icon: string;
  active?: boolean;
  badge?: number;
  onPress: () => void;
  /** Idle tint. Defaults to slate on paper, muted white on dark. */
  tint?: string;
  activeTint?: string;
  /** Required for icon-only chips (no visible label for the reader to use). */
  accessibilityLabel?: string;
}) {
  const palette = useAccentPalette();
  const dark = useColorScheme().colorScheme === "dark";
  // `activeTint` used to default to a hardcoded olive in the parameter list,
  // which a hook cannot reach — the accent is resolved here instead.
  const color = active
    ? (activeTint ?? palette.glassFor(dark))
    : (tint ?? (dark ? "rgba(255,255,255,0.66)" : "#4C556F"));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 11,
        height: 34,
        borderRadius: 999,
        backgroundColor: active
          ? `${palette.fill}${dark ? "33" : "29"}`
          : dark
            ? "rgba(255,255,255,0.06)"
            : "rgba(255,255,255,0.65)",
        borderWidth: 1,
        borderColor: active
          ? `${palette.fill}80`
          : dark
            ? "rgba(255,255,255,0.12)"
            : "rgba(9,27,84,0.12)",
      }}
    >
      <Ionicons name={icon as never} size={13} color={color} />
      {label ? <Text style={{ fontSize: 12, fontWeight: "600", color }}>{label}</Text> : null}
      {badge !== undefined && badge > 0 ? (
        <View style={{ backgroundColor: palette.fill, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 }}>
          <Text style={{ color: "#FFFFFF", fontSize: 10, fontWeight: "700" }}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
