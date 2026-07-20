import { LinearGradient } from "expo-linear-gradient";
import { useColorScheme } from "nativewind";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import { useFieldMode } from "@/lib/stores/settings";

/**
 * Full-screen warm-paper (light) / near-black (dark) gradient backdrop with soft
 * accent glows — mirrors WorkspaceBackdrop / workspaceBackdropGradient
 * (ContentView.swift). Sits behind all screens.
 *
 * The glows are SVG radial gradients rather than plain views. A View can only be
 * a hard-edged disc — which is what this drew before, despite the comment
 * claiming otherwise, and why the backdrop read flat against the design.
 * expo-linear-gradient has no radial mode, so the falloff comes from
 * react-native-svg.
 */

/** Each glow as a fraction of the screen, so the composition holds at any size. */
const GLOWS = [
  // Blue, upper-left — the cool end of the diagonal wash.
  { id: "glowBlue", size: 0.78, inset: -0.22, drop: -0.26, anchorX: "left", anchorY: "top", peak: 0.95, mid: 0.42 },
  // Mint, upper-right — a faint bridge between the two.
  { id: "glowMint", size: 0.46, inset: 0.16, drop: -0.14, anchorX: "right", anchorY: "top", peak: 0.55, mid: 0.2 },
  // Green, lower-right — the organic end.
  { id: "glowGreen", size: 0.82, inset: -0.26, drop: -0.3, anchorX: "right", anchorY: "bottom", peak: 0.9, mid: 0.38 },
] as const;

export function WorkspaceBackdrop() {
  const { colorScheme } = useColorScheme();
  const { width, height } = useWindowDimensions();
  // Field mode: flat bright paper, no glows — atmosphere costs contrast in sun.
  const field = useFieldMode();
  const dark = colorScheme === "dark" && !field;

  if (field) {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: "#FBFAF4" }]} pointerEvents="none" />
    );
  }

  const stops = dark
    ? (["#14181F", "#1A1A1F", "#12171A"] as const)
    : (["#F2F7FF", "#FAF7F0", "#EDF5EE"] as const);

  const tints: Record<(typeof GLOWS)[number]["id"], string> = dark
    ? { glowBlue: "#243247", glowMint: "#22392F", glowGreen: "#1F3B34" }
    : { glowBlue: "#B9CEEB", glowMint: "#C6E0D0", glowGreen: "#A7D0C7" };

  // Against near-black the same opacities barely register, so ease them back.
  const gain = dark ? 0.75 : 1;

  // Resolve each glow to pixels once, so the gradient and the circle it fills are
  // guaranteed to describe the same place.
  const placed = GLOWS.map((g) => {
    const d = width * g.size;
    return {
      ...g,
      r: d / 2,
      cx: g.anchorX === "left" ? g.inset * width + d / 2 : width - g.inset * width - d / 2,
      cy: g.anchorY === "top" ? g.drop * height + d / 2 : height - g.drop * height - d / 2,
    };
  });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={stops}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Svg style={StyleSheet.absoluteFill} width={width} height={height}>
        <Defs>
          {placed.map((g) => (
            // userSpaceOnUse: the gradient is described in the same pixel space as
            // the circle. The default (objectBoundingBox) resolves percentages
            // against each shape's bounding box, which is easy to get subtly wrong
            // and paints nothing at all when it is.
            <RadialGradient key={g.id} id={g.id} gradientUnits="userSpaceOnUse" cx={g.cx} cy={g.cy} r={g.r}>
              <Stop offset="0" stopColor={tints[g.id]} stopOpacity={g.peak * gain} />
              <Stop offset="0.43" stopColor={tints[g.id]} stopOpacity={g.mid * gain} />
              {/* Transparent before the circle's edge — that's the whole point. */}
              <Stop offset="0.72" stopColor={tints[g.id]} stopOpacity={0} />
            </RadialGradient>
          ))}
        </Defs>
        {placed.map((g) => (
          <Circle key={g.id} cx={g.cx} cy={g.cy} r={g.r} fill={`url(#${g.id})`} />
        ))}
      </Svg>
    </View>
  );
}
