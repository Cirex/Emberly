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
  { id: "glowBlue", size: 0.95, inset: -0.24, drop: -0.28, anchorX: "left", anchorY: "top", peak: 1, mid: 0.5 },
  // Mint, upper-right — a bridge between the two.
  { id: "glowMint", size: 0.55, inset: 0.14, drop: -0.16, anchorX: "right", anchorY: "top", peak: 0.65, mid: 0.28 },
  // Green, lower-right — the organic end.
  { id: "glowGreen", size: 1.0, inset: -0.28, drop: -0.32, anchorX: "right", anchorY: "bottom", peak: 1, mid: 0.46 },
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
    : (["#DCE9FD", "#F8F5EC", "#D6EBDE"] as const);

  // Light tints run more saturated than security's: almost every pixel here
  // sits behind a blurred glass card, which eats about half the chroma — the
  // deeper source colors are what let the blue/green wash read THROUGH the
  // cards instead of only in the gaps between them.
  const tints: Record<(typeof GLOWS)[number]["id"], string> = dark
    ? { glowBlue: "#243247", glowMint: "#22392F", glowGreen: "#1F3B34" }
    : { glowBlue: "#6C9AE3", glowMint: "#7FC49C", glowGreen: "#4BA891" };

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
              <Stop offset="0.48" stopColor={tints[g.id]} stopOpacity={g.mid * gain} />
              {/* Transparent before the circle's edge — that's the whole point. */}
              <Stop offset="0.78" stopColor={tints[g.id]} stopOpacity={0} />
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
