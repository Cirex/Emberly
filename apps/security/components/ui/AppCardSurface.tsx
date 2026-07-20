import { useColorScheme } from "nativewind";
import type { ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { useFieldMode } from "@/lib/stores/settings";

type Kind = "row" | "panel";
const RADIUS: Record<Kind, number> = { row: 14, panel: 20 };

interface AppCardSurfaceProps extends ViewProps {
  children?: ReactNode;
  kind?: Kind;
  selected?: boolean;
  className?: string;
}

/**
 * AppCardSurface (AppDesignSystem.swift): light white@62% / dark white@5% fill,
 * 1px stroke (light navy@8% / dark white@10%), radius row=14 / panel=20,
 * subtle drop shadow (deepened when selected).
 */
export function AppCardSurface({
  children,
  kind = "row",
  selected = false,
  className = "",
  style,
  ...rest
}: AppCardSurfaceProps) {
  const { colorScheme } = useColorScheme();
  // Field mode: opaque white and a border ~3× stronger, so cards keep their
  // shape in direct sunlight where the translucent hairline washes out.
  const field = useFieldMode();
  const dark = colorScheme === "dark" && !field;
  const r = RADIUS[kind];

  return (
    <View
      className={className}
      style={[
        {
          borderRadius: r,
          borderWidth: selected ? 1.2 : field ? 1.4 : 1,
          borderColor: selected
            ? "rgba(162,169,33,0.88)" // olive@88%
            : dark
              ? "rgba(255,255,255,0.10)"
              : field
                ? "rgba(9,27,84,0.28)"
                : "rgba(9,27,84,0.08)", // navy@8%
          backgroundColor: dark ? "rgba(255,255,255,0.05)" : field ? "#FFFFFF" : "rgba(255,255,255,0.62)",
          shadowColor: "#000",
          shadowOpacity: selected ? 0.085 : 0.045,
          shadowRadius: selected ? 18 : 10,
          shadowOffset: { width: 0, height: selected ? 8 : 4 },
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}
