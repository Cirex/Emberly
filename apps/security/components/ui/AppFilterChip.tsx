import { LinearGradient } from "expo-linear-gradient";
import { Pressable, Text } from "react-native";

interface AppFilterChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
}

/**
 * AppFilterChip (AppFilterChipRow.swift): capsule, height 36, H-pad 16, font 14
 * semibold. Selected = olive gradient (top→bottom) + white text + olive shadow.
 * Unselected = white gradient + navy@82% text.
 */
export function AppFilterChip({ label, selected = false, onPress }: AppFilterChipProps) {
  const gradient = selected
    ? (["#B1B822", "#8D950E"] as const) // olive top → bottom
    : (["rgba(255,255,255,0.62)", "rgba(255,255,255,0.32)"] as const);

  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <LinearGradient
        colors={gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          height: 36,
          paddingHorizontal: 16,
          justifyContent: "center",
          borderRadius: 999,
          borderWidth: 1,
          borderColor: selected ? "rgba(162,169,33,0.38)" : "rgba(255,255,255,0.70)",
          shadowColor: selected ? "#A2A921" : "transparent",
          shadowOpacity: selected ? 0.22 : 0,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
        }}
      >
        <Text
          style={{
            fontSize: 14,
            fontWeight: "600",
            color: selected ? "#FFFFFF" : "rgba(9,27,84,0.82)",
          }}
        >
          {label}
        </Text>
      </LinearGradient>
    </Pressable>
  );
}
