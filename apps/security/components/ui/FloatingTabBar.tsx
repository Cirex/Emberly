import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { useEffect, useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassSurface } from "./GlassSurface";

const ICONS: Record<string, ComponentIcon> = {
  index: "business",
  "property-map": "map",
  scanner: "scan",
  "guest-passes": "ticket",
};
type ComponentIcon = React.ComponentProps<typeof Ionicons>["name"];

/**
 * Structural props for a custom tab bar. expo-router 57 dropped
 * @react-navigation for standard-navigation, so we type only the surface this
 * component actually consumes rather than importing a navigator-specific
 * `BottomTabBarProps` (which now resolves to two conflicting copies — the one
 * bundled inside expo-router and the standalone package). The object expo-router
 * passes to `tabBar` is a structural superset of this, so it assigns cleanly.
 */
type FloatingTabBarProps = {
  state: { index: number; routes: Array<{ key: string; name: string }> };
  descriptors: Record<string, { options: { title?: string } }>;
  navigation: {
    emit(event: { type: "tabPress"; target: string; canPreventDefault: true }): {
      defaultPrevented: boolean;
    };
    navigate(name: string): void;
  };
};

const TAB_HEIGHT = 44;

/** Close to the iOS "Liquid Glass" settle: quick, barely overshooting. */
const SLIDE = { damping: 18, stiffness: 220, mass: 0.7 };

type Slot = { x: number; width: number };

/**
 * Floating glass capsule tab bar (IosFloatingWorkspaceTabBar,
 * WorkspaceShellView.swift): pill segments, the selected one an olive glass
 * lozenge that slides between tabs rather than blinking from one to the next.
 * Used on both iPhone and iPad (the iPad "wide shell" refinement lands later).
 */
export function FloatingTabBar({ state, descriptors, navigation }: FloatingTabBarProps) {
  const insets = useSafeAreaInsets();
  // Idle tabs were navy-on-dark-glass at night — invisible. The selected tab is
  // white-on-olive either way, so only the idle colors follow the scheme.
  const dark = useColorScheme().colorScheme === "dark";
  const idleIcon = dark ? "rgba(255,255,255,0.60)" : "#70788F";
  const idleLabel = dark ? "rgba(255,255,255,0.72)" : "rgba(9,27,84,0.72)";

  // The lozenge is positioned from the tabs' measured frames — they size to their
  // own labels, so nothing here can be computed ahead of layout.
  const [slots, setSlots] = useState<Record<number, Slot>>({});
  const left = useSharedValue(0);
  const width = useSharedValue(0);
  const ready = useSharedValue(0);

  const active = slots[state.index];

  useEffect(() => {
    if (!active) return;
    // First measurement lands without animation — otherwise the lozenge flies in
    // from the left edge on every cold start.
    if (ready.value === 0) {
      left.value = active.x;
      width.value = active.width;
      ready.value = withTiming(1, { duration: 120 });
      return;
    }
    left.value = withSpring(active.x, SLIDE);
    width.value = withSpring(active.width, SLIDE);
  }, [active, left, width, ready]);

  const lozenge = useAnimatedStyle(() => ({
    left: left.value,
    width: width.value,
    opacity: ready.value,
  }));

  const measure = (index: number) => (e: LayoutChangeEvent) => {
    const { x, width: w } = e.nativeEvent.layout;
    setSlots((prev) =>
      prev[index]?.x === x && prev[index]?.width === w ? prev : { ...prev, [index]: { x, width: w } },
    );
  };

  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + 10, alignItems: "center" }}
    >
      <GlassSurface
        radius="feature"
        style={{
          borderRadius: 999,
          shadowColor: "#000",
          shadowOpacity: 0.16,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 14 },
        }}
      >
        <View className="flex-row items-center" style={{ padding: 6, gap: 4 }}>
          {/* Olive tint over the capsule's own blur rather than an opaque fill —
              the frosting behind still reads through, and the light stroke is
              what makes it sit on the glass instead of on top of it. */}
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: "absolute",
                top: 6,
                height: TAB_HEIGHT,
                borderRadius: 999,
                backgroundColor: "rgba(162,169,33,0.82)",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.45)",
              },
              lozenge,
            ]}
          />

          {state.routes.map((route, index) => {
            const focused = state.index === index;
            const { options } = descriptors[route.key];
            const label = typeof options.title === "string" ? options.title : route.name;

            const onPress = () => {
              const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
            };

            return (
              <Pressable
                key={route.key}
                onPress={onPress}
                onLayout={measure(index)}
                accessibilityRole="button"
                accessibilityState={focused ? { selected: true } : {}}
                style={{
                  minWidth: 118,
                  height: TAB_HEIGHT,
                  paddingHorizontal: 16,
                  borderRadius: 999,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 7,
                }}
              >
                <Ionicons name={ICONS[route.name] ?? "ellipse"} size={18} color={focused ? "#FFFFFF" : idleIcon} />
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: focused ? "600" : "500",
                    color: focused ? "#FFFFFF" : idleLabel,
                  }}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </GlassSurface>
    </View>
  );
}
