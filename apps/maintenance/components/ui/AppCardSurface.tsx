import { BlurView } from "expo-blur";
import { useColorScheme } from "nativewind";
import type { ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { useFieldMode } from "@/lib/stores/settings";
import { useAccentPalette } from "@/lib/hooks/use-accent";
import { OPAQUE_GLASS, androidGlassFill } from "@/theme/android-glass";

type Kind = "row" | "panel";
const RADIUS: Record<Kind, number> = { row: 14, panel: 20 };

interface AppCardSurfaceProps extends ViewProps {
  children?: ReactNode;
  kind?: Kind;
  selected?: boolean;
  className?: string;
}

/**
 * AppCardSurface (AppDesignSystem.swift), maintenance variant: liquid glass by
 * default — a blur underlay with a lighter fill, so the WorkspaceBackdrop's
 * radial glows read through every card. 1px stroke (light navy@8% / dark
 * white@10%), radius row=14 / panel=20, subtle drop shadow (deepened when
 * selected). Field mode drops the glass for opaque white — translucency is
 * exactly what dies in direct sunlight.
 */
export function AppCardSurface({
  children,
  kind = "row",
  selected = false,
  className = "",
  style,
  ...rest
}: AppCardSurfaceProps) {
  const palette = useAccentPalette();
  const { colorScheme } = useColorScheme();
  const field = useFieldMode();
  const dark = colorScheme === "dark" && !field;
  const r = RADIUS[kind];
  // Android has no blur to lay under the card, so the fill carries the whole
  // surface. Field mode already made this exact call on both platforms, so it
  // keeps its own opaque white rather than getting a second definition here.
  const androidGlass = OPAQUE_GLASS && !field;

  return (
    <View
      className={className}
      style={[
        {
          borderRadius: r,
          borderWidth: selected ? 1.2 : field ? 1.4 : 1,
          borderColor: selected
            ? `${palette.fill}E0` // olive@88%
            : dark
              ? "rgba(255,255,255,0.10)"
              : field
                ? "rgba(9,27,84,0.28)"
                : "rgba(9,27,84,0.08)", // navy@8%
          backgroundColor: androidGlass
            ? androidGlassFill("card", dark, selected)
            : dark
              ? "rgba(255,255,255,0.045)"
              : field
                ? "#FFFFFF"
                : "rgba(255,255,255,0.17)",
          shadowColor: "#000",
          shadowOpacity: selected ? 0.085 : 0.045,
          shadowRadius: selected ? 18 : 10,
          shadowOffset: { width: 0, height: selected ? 8 : 4 },
          // Android ignores the shadow* props entirely; elevation is the only
          // way these cards lift off the backdrop there. A card at rest sits
          // BELOW the floating chrome (3), a selected one just above it.
          ...(androidGlass ? { elevation: selected ? 4 : 2 } : null),
        },
        style,
      ]}
      {...rest}
    >
      {/* The glass: an absolute blur layer under the content. Skipped in field
          mode, where the fill above is already opaque — and on Android, where
          BlurView draws no blur and the fill above is opaque for that reason. */}
      {!field && !OPAQUE_GLASS ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: r,
            overflow: "hidden",
            zIndex: -1,
          }}
        >
          <BlurView intensity={dark ? 22 : 13} tint={dark ? "dark" : "light"} style={{ flex: 1 }} />
        </View>
      ) : null}
      {children}
    </View>
  );
}
