import { BlurView } from "expo-blur";
import { useColorScheme } from "nativewind";
import type { ReactNode } from "react";
import { Platform, View, type ViewProps } from "react-native";
import { useFieldMode } from "@/lib/stores/settings";

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
 * ANDROID IS OPAQUE ON PURPOSE.
 *
 * expo-blur renders no blur on Android: BlurView's blurMethod defaults to
 * 'none' and the fallback is a flat wash at intensity/100 * 0.78 opacity. On
 * iOS the translucency reads as glass because the blur separates the surface
 * from what's behind it. Without the blur it is just a thin veil — and these
 * surfaces sit directly on top of the live property map, so at 40 intensity
 * (~31% white) the map's own lines and unit numbers show straight through the
 * tab bar, the legend and the callouts.
 *
 * Dimezis blur would restore the real effect, but it needs a blurTarget ref
 * threaded through every call site. Opaque is the honest fix: on Android the
 * surface becomes a solid card and stays readable over anything.
 *
 * Field mode already made this choice on both platforms — near-solid white,
 * because translucency is exactly what dies in direct sunlight.
 */
const ANDROID_FILL = {
  dark: { base: "#1B2033", active: "#2A3149" },
  light: { base: "#FFFFFF", active: "#F1EFE6" },
  field: { base: "#FFFFFF", active: "#FFFFFF" },
} as const;

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
  const opaque = Platform.OS === "android";

  const borderColor = dark
    ? "rgba(255,255,255,0.10)"
    : field
      ? "rgba(9,27,84,0.28)"
      : opaque
        ? "rgba(9,27,84,0.12)"
        : "rgba(255,255,255,0.30)";

  const fill = opaque
    ? ANDROID_FILL[field ? "field" : dark ? "dark" : "light"][active ? "active" : "base"]
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
          : "rgba(255,255,255,0.40)";

  const inner = (
    <View
      style={{
        borderRadius: r,
        borderWidth: field ? 1.4 : 1,
        borderColor,
        backgroundColor: fill,
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
        // small elevation keeps the surface off the map on Android.
        opaque && !field ? { elevation: 3 } : null,
        style,
      ]}
      className={className}
      {...rest}
    >
      {opaque ? (
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
