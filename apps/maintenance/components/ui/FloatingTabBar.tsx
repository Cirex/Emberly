import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { ACCENT_THEMES, NAVY, OLIVE_GLASS, OLIVE_GLASS_DARK } from "@/theme/tokens";
import { useAccentHex } from "@/lib/hooks/use-accent";
import { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFieldMode } from "@/lib/stores/settings";
import { useMapSearch } from "@/lib/stores/map-search";
import { useWorkOrdersView } from "@/lib/stores/work-orders-view";
import { markTabPress } from "@/lib/perf/render-trace";

const ICONS: Record<string, ComponentIcon> = {
  index: "compass",
  "work-orders": "construct",
  "make-ready": "hammer",
  "property-map": "map",
};
type ComponentIcon = React.ComponentProps<typeof Ionicons>["name"];

/**
 * Structural props for a custom tab bar. expo-router 57 dropped
 * @react-navigation for standard-navigation, so we type only the surface this
 * component actually consumes rather than importing a navigator-specific
 * `BottomTabBarProps`. The object expo-router passes to `tabBar` is a
 * structural superset of this, so it assigns cleanly.
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

// Apple-Music proportions: a 62pt capsule, the selected lozenge inset 4pt so
// it runs nearly edge-to-edge vertically, and a matching round search bubble.
const BAR = 62;
const INSET = 4;
const GAP = 8;
const EDGE = 12;

/** Close to the iOS "Liquid Glass" settle: quick, barely overshooting. */
const SLIDE = { damping: 18, stiffness: 220, mass: 0.7 };
/** The capsule morph — a touch softer so the stretch reads as liquid. */
const MORPH = { damping: 21, stiffness: 190, mass: 0.85 };

type Slot = { x: number; width: number };

const SHADOW = {
  shadowColor: "#000",
  shadowOpacity: 0.16,
  shadowRadius: 24,
  shadowOffset: { width: 0, height: 14 },
} as const;

/**
 * Floating glass tab bar in the native Liquid Glass anatomy (the Apple Music
 * bottom bar): one near-full-width capsule of equal-width icon-over-label tabs
 * whose selected tab carries a FULL-HEIGHT light-glass lozenge with
 * accent-tinted content, plus a round search bubble beside it on the screens
 * whose lists the search filters. Tapping search springs the capsule down into
 * a round button showing the active tab's icon while the bubble stretches into
 * the full-width field — both surfaces stay mounted so the blur never pops.
 * When a screen has no search, the capsule springs out to take the whole row.
 */
export function FloatingTabBar({ state, descriptors, navigation }: FloatingTabBarProps) {
  const insets = useSafeAreaInsets();
  const dark = useColorScheme().colorScheme === "dark";

  // Selected content takes the accent (like Music's red); the lozenge itself is
  // elevated glass, not a colored fill.
  // The chosen accent, not a hardcoded olive — this is the navigation chrome
  // the accent setting is meant to reach. The olive glass tones stay as the
  // brand default so a fresh install looks exactly as it did.
  const accentHexValue = useAccentHex();
  const accent =
    accentHexValue === ACCENT_THEMES.olive.hex
      ? dark
        ? OLIVE_GLASS_DARK
        : OLIVE_GLASS
      : accentHexValue;
  const idleIcon = dark ? "rgba(255,255,255,0.62)" : "rgba(9,27,84,0.58)";
  const idleLabel = dark ? "rgba(255,255,255,0.72)" : "rgba(9,27,84,0.66)";
  const lozengeFill = dark ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.82)";

  // Search lives in the bar on every screen that has a searchable surface: the
  // Work Orders workspace, the Make Ready board (both drive the derived
  // engine's text search) and the property map (its unit search).
  const routeName = state.routes[state.index]?.name;
  const onMap = routeName === "property-map";
  const searchable = routeName === "work-orders" || routeName === "make-ready" || onMap;

  // Glass recipe (mirrors GlassSurface, inlined because these two surfaces
  // animate their width — the generic wrapper's flex sizing collapses inside
  // width-animated parents).
  const field = useFieldMode();
  const glassDark = dark && !field;
  const glassFill = glassDark
    ? "rgba(255,255,255,0.05)"
    : field
      ? "rgba(255,255,255,0.85)"
      : "rgba(255,255,255,0.40)";
  const glassBorder = glassDark
    ? "rgba(255,255,255,0.10)"
    : field
      ? "rgba(9,27,84,0.28)"
      : "rgba(255,255,255,0.30)";
  const glassBlur = field ? 12 : glassDark ? 30 : 40;

  // The field binds the map's unit search on the map route, the work-order
  // text search everywhere else.
  const woSearch = useWorkOrdersView((s) => s.search);
  const woSetSearch = useWorkOrdersView((s) => s.setSearch);
  const mapQuery = useMapSearch((s) => s.query);
  const mapSetQuery = useMapSearch((s) => s.setQuery);
  const search = onMap ? mapQuery : woSearch;
  const setSearch = onMap ? mapSetQuery : woSetSearch;
  const placeholder = onMap ? "Unit, resident, or street" : "Work orders, units, technicians…";
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);

  // 0 = tabs + bubble at rest, 1 = condensed circle + full-width field.
  const progress = useSharedValue(0);
  // The row's usable width (minus edge padding). Both surfaces derive their
  // widths from this single number so their sum can NEVER exceed the row —
  // mid-spring included. (An earlier version let the capsule spring while the
  // bubble held its width; on a phone the sum transiently overflowed and shoved
  // the bubble off screen.)
  const rowW = useSharedValue(0);
  // 1 = the bubble exists (searchable tab), 0 = the capsule owns the row. The
  // bubble stays MOUNTED either way and liquid-shrinks to nothing.
  const bubble = useSharedValue(searchable ? 1 : 0);
  const placedBubble = useRef(false);

  useEffect(() => {
    const target = searchable ? 1 : 0;
    bubble.value = placedBubble.current ? withSpring(target, MORPH) : target;
    placedBubble.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchable]);

  const toggleSearch = (open: boolean) => {
    setSearchOpen(open);
    progress.value = withSpring(open ? 1 : 0, MORPH);
    // Deliberately NOT auto-focusing on open — the keyboard covering half the
    // list on every tap was worse than one extra tap into the field.
    if (!open) {
      inputRef.current?.blur();
      Keyboard.dismiss();
    }
  };

  // Collapse the field whenever the tab changes: it would otherwise stay open
  // bound to a different screen's search (and, on a searchless tab, filter a
  // list the user can't see).
  useEffect(() => {
    if (searchOpen) toggleSearch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeName]);

  // Ride above the keyboard while searching (Apple Music does the same).
  const kb = useSharedValue(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", (e) => {
      kb.value = withTiming(Math.max(e.endCoordinates.height - insets.bottom, 0), {
        duration: e.duration || 250,
      });
    });
    const hide = Keyboard.addListener("keyboardWillHide", (e) => {
      kb.value = withTiming(0, { duration: e.duration || 250 });
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [insets.bottom, kb]);
  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: -kb.value }] }));

  // Tabs capsule ⇄ condensed circle. The rest width cedes exactly the space
  // the bubble currently occupies, so capsule + spacing + bubble ≡ row width
  // at every frame. Until the row is measured the capsule flexes naturally
  // (progress and bubble can't be mid-flight then).
  const capsuleStyle = useAnimatedStyle(() => {
    if (rowW.value === 0) return {};
    const rest = rowW.value - bubble.value * (BAR + GAP);
    return { width: interpolate(progress.value, [0, 1], [rest, BAR]) };
  });
  // Search bubble ⇄ field — collapsed to zero width on searchless tabs. We
  // hide it by width alone, NOT opacity: an opacity < 1 anywhere above a
  // BlurView rasterizes the subtree on iOS and kills its live backdrop blur,
  // which is exactly why the search bubble read as flat glass.
  const searchStyle = useAnimatedStyle(() => {
    if (rowW.value === 0) return { width: searchable ? BAR : 0, marginLeft: searchable ? GAP : 0 };
    return {
      width: interpolate(progress.value, [0, 1], [bubble.value * BAR, rowW.value - BAR - GAP]),
      marginLeft: interpolate(progress.value, [0, 1], [bubble.value * GAP, GAP]),
    };
  });
  // Content cross-fades: tabs out early, condensed icon + input in late.
  const tabsFade = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.45], [1, 0], "clamp"),
  }));
  const condensedFade = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.55, 1], [0, 1], "clamp"),
  }));
  const inputFade = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.55, 1], [0, 1], "clamp"),
  }));

  // The lozenge is positioned from the tabs' measured frames — equal flex
  // widths, but measuring keeps it honest under any label length.
  const [slots, setSlots] = useState<Record<number, Slot>>({});
  const left = useSharedValue(0);
  const width = useSharedValue(0);
  const ready = useSharedValue(0);

  const active = slots[state.index];

  useEffect(() => {
    if (!active) return;
    // First measurement lands without animation — otherwise the lozenge flies
    // in from the left edge on every cold start.
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
    <Animated.View
      pointerEvents="box-none"
      style={[
        { position: "absolute", left: 0, right: 0, bottom: insets.bottom + 8, alignItems: "center" },
        lift,
      ]}
    >
      <View
        pointerEvents="box-none"
        onLayout={(e) => {
          rowW.value = e.nativeEvent.layout.width - EDGE * 2;
        }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: EDGE,
          width: "100%",
          maxWidth: 620,
        }}
      >
        {/* ---- Tabs capsule ⇄ condensed circle (one glass surface) --------- */}
        <Animated.View style={[{ height: BAR, borderRadius: 999, flexGrow: 1, ...SHADOW }, capsuleStyle]}>
          <View
            style={{
              width: "100%",
              height: "100%",
              borderRadius: 999,
              overflow: "hidden",
              borderWidth: field ? 1.4 : 1,
              borderColor: glassBorder,
              backgroundColor: glassFill,
            }}
          >
            {!field ? (
              <BlurView
                intensity={glassBlur}
                tint={glassDark ? "dark" : "light"}
                style={StyleSheet.absoluteFill}
              />
            ) : null}
            {/* The tabs — fade out as the capsule condenses. */}
            <Animated.View
              pointerEvents={searchOpen ? "none" : "auto"}
              style={[
                { flexDirection: "row", alignItems: "center", height: "100%", padding: INSET },
                tabsFade,
              ]}
            >
              {/* Native-style lozenge: elevated glass running nearly the full
                  capsule height; the CONTENT takes the accent, not the fill. */}
              <Animated.View
                pointerEvents="none"
                style={[
                  {
                    position: "absolute",
                    top: INSET,
                    bottom: INSET,
                    borderRadius: 999,
                    backgroundColor: lozengeFill,
                    shadowColor: NAVY,
                    shadowOpacity: dark ? 0 : 0.14,
                    shadowRadius: 10,
                    shadowOffset: { width: 0, height: 3 },
                  },
                  lozenge,
                ]}
              />
              {state.routes.map((route, index) => {
                const focused = state.index === index;
                const { options } = descriptors[route.key];
                const label = typeof options.title === "string" ? options.title : route.name;

                const onPress = () => {
                  // Starts the clock for the render trace, so a slow commit can
                  // be reported as "Nms after tapping Map" rather than in
                  // isolation. Compiled out of release builds.
                  markTabPress(route.name);
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
                      flex: 1,
                      minWidth: 0,
                      height: "100%",
                      borderRadius: 999,
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 2,
                    }}
                  >
                    <Ionicons
                      name={ICONS[route.name] ?? "ellipse"}
                      size={21}
                      color={focused ? accent : idleIcon}
                    />
                    <Text
                      numberOfLines={1}
                      style={{
                        fontSize: 10.5,
                        fontWeight: focused ? "700" : "500",
                        color: focused ? accent : idleLabel,
                        paddingHorizontal: 2,
                      }}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </Animated.View>
            {/* Condensed face: the grid glyph (Apple Music's "App" button).
                Tapping it restores the tabs. */}
            <Animated.View
              pointerEvents={searchOpen ? "auto" : "none"}
              style={[StyleSheet.absoluteFill, condensedFade]}
            >
              <Pressable
                onPress={() => toggleSearch(false)}
                accessibilityRole="button"
                accessibilityLabel="Show tabs"
                style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
              >
                <Ionicons name="grid" size={22} color={accent} />
              </Pressable>
            </Animated.View>
          </View>
        </Animated.View>

        {/* ---- Search bubble ⇄ field (always mounted; width 0 on searchless
                tabs so it can liquid-shrink instead of popping) ------------- */}
        <Animated.View
          pointerEvents={searchable ? "auto" : "none"}
          style={[{ height: BAR, borderRadius: 999, ...SHADOW }, searchStyle]}
        >
          <View
            style={{
              width: "100%",
              height: "100%",
              borderRadius: 999,
              overflow: "hidden",
              borderWidth: field ? 1.4 : 1,
              borderColor: glassBorder,
              backgroundColor: glassFill,
            }}
          >
            {!field ? (
              <BlurView
                intensity={glassBlur}
                tint={glassDark ? "dark" : "light"}
                style={StyleSheet.absoluteFill}
              />
            ) : null}
            <Pressable
              disabled={searchOpen || !searchable}
              onPress={() => toggleSearch(true)}
              accessibilityRole="button"
              accessibilityLabel={onMap ? "Search units" : "Search work orders"}
              style={{ width: "100%", height: "100%" }}
            >
              {/* Closed face: the magnifier truly centered in the circle —
                  nothing else shares the row to shove it sideways. */}
              <Animated.View
                pointerEvents="none"
                style={[
                  StyleSheet.absoluteFill,
                  { alignItems: "center", justifyContent: "center" },
                  tabsFade,
                ]}
              >
                <Ionicons
                  name="search"
                  size={20}
                  color={dark ? "rgba(255,255,255,0.85)" : "rgba(9,27,84,0.78)"}
                />
              </Animated.View>
              {/* Open face: magnifier + the input, leading-aligned. */}
              <Animated.View
                pointerEvents={searchOpen ? "auto" : "none"}
                style={[
                  StyleSheet.absoluteFill,
                  { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, gap: 8 },
                  inputFade,
                ]}
              >
                <Ionicons
                  name="search"
                  size={20}
                  color={dark ? "rgba(255,255,255,0.85)" : "rgba(9,27,84,0.78)"}
                />
                <TextInput
                  ref={inputRef}
                  value={search}
                  onChangeText={setSearch}
                  placeholder={placeholder}
                  placeholderTextColor={idleIcon}
                  returnKeyType="search"
                  clearButtonMode="while-editing"
                  autoCorrect={false}
                  style={{
                    flex: 1,
                    fontSize: 16,
                    color: dark ? "rgba(255,255,255,0.9)" : NAVY,
                    height: "100%",
                  }}
                />
              </Animated.View>
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Animated.View>
  );
}
