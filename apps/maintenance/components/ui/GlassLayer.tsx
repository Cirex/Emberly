import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { OPAQUE_GLASS, androidGlassFill, type GlassRole } from "@/theme/android-glass";

interface GlassLayerProps {
  /** Which material this surface is; picks the Android fill. */
  role: GlassRole;
  dark: boolean;
  /** iOS blur strength. Android has no blur to set a strength on. */
  intensity: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

/**
 * The glass a sheet or panel is WRAPPED IN — a BlurView on iOS, a plain
 * opaque View on Android. (The surfaces that instead lay a blur UNDER their
 * own content, as an absoluteFill sibling, just skip that sibling and paint
 * their fill opaque; they need no wrapper.)
 *
 * Callers keep their own translucent wash in `style` for iOS. On Android that
 * wash is replaced outright by the role's opaque fill rather than layered
 * over it, so every panel in the app lands on the same colour instead of on
 * whatever its own alpha happens to composite to. See @/theme/android-glass.
 */
export function GlassLayer({ role, dark, intensity, style, children }: GlassLayerProps) {
  if (OPAQUE_GLASS) {
    return (
      <View style={[style, { backgroundColor: androidGlassFill(role, dark) }]}>{children}</View>
    );
  }
  return (
    <BlurView intensity={intensity} tint={dark ? "dark" : "light"} style={style}>
      {children}
    </BlurView>
  );
}
