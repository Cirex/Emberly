import { BlurView } from "expo-blur";
import { useColorScheme } from "nativewind";
import type { ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { useFieldMode } from "@/lib/stores/settings";
import {
  ANDROID_GLASS_ELEVATION,
  ANDROID_GLASS_HAIRLINE,
  OPAQUE_GLASS,
  androidGlassFill,
} from "@/theme/android-glass";

type Radius = "control" | "panel" | "feature";

const RADIUS_PX: Record<Radius, number> = { control: 18, panel: 20, feature: 22 };

interface GlassSurfaceProps extends ViewProps {
  children?: ReactNode;
  /** A named size, or an explicit radius for surfaces the scale doesn't cover. */
  radius?: Radius | number;
  /** Selected/active tint (uses the runtime accent). */
  active?: boolean;
  className?: string;
}

/**
 * Approximation of the iOS "Liquid Glass" material (AppGlassControlSurface /
 * AppGlassPanel): translucent blur + faint tinted fill + a 1px light stroke.
 * True iOS 26 glass isn't reproducible in RN — this is the agreed stand-in.
 *
 * On Android there is no blur to approximate anything with, so the surface
 * goes opaque; see @/theme/android-glass for why, and for the palette.
 */
export function GlassSurface({
  children,
  radius = "control",
  active = false,
  className = "",
  style,
  ...rest
}: GlassSurfaceProps) {
  const { colorScheme } = useColorScheme();
  // Field mode trades the glass for near-solid white with a visible navy
  // border — translucency is exactly what dies in direct sunlight.
  const field = useFieldMode();
  const dark = colorScheme === "dark" && !field;
  const r = typeof radius === "number" ? radius : RADIUS_PX[radius];
  // The BlurView never renders on Android: it produces no blur there, only a
  // faint wash. Field mode, though, already resolved this surface to its own
  // opaque fill on BOTH platforms — so it keeps that fill and only the dead
  // BlurView goes away, rather than Android growing a second, drifting copy.
  const androidGlass = OPAQUE_GLASS && !field;

  const inner = (
    <View
      style={{
        borderRadius: r,
        borderWidth: field ? 1.4 : 1,
        borderColor: dark
          ? "rgba(255,255,255,0.10)"
          : field
            ? "rgba(9,27,84,0.28)"
            : androidGlass
              ? ANDROID_GLASS_HAIRLINE
              : "rgba(255,255,255,0.30)",
        backgroundColor: androidGlass
          ? androidGlassFill("chrome", dark, active)
          : active
            ? dark
              ? "rgba(255,255,255,0.14)"
              : field
                ? "rgba(255,255,255,0.92)"
                : "rgba(255,255,255,0.55)"
            : dark
              ? "rgba(255,255,255,0.05)"
              : field
                ? "rgba(255,255,255,0.85)"
                : "rgba(255,255,255,0.40)",
      }}
    >
      {children}
    </View>
  );

  return (
    <View
      style={[
        { borderRadius: r, overflow: "hidden" },
        // The blur used to supply the visual lift on iOS; with it gone, a
        // small elevation keeps the surface off whatever it floats over.
        androidGlass ? { elevation: ANDROID_GLASS_ELEVATION } : null,
        style,
      ]}
      className={className}
      {...rest}
    >
      {OPAQUE_GLASS ? (
        inner
      ) : (
        <BlurView
          intensity={field ? 12 : dark ? 30 : 40}
          tint={dark ? "dark" : "light"}
          style={{ borderRadius: r }}
        >
          {inner}
        </BlurView>
      )}
    </View>
  );
}
