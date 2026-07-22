import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useRouter } from "expo-router";
import { useColorScheme } from "nativewind";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InitialsBadge } from "@/components/ui/InitialsBadge";
import { useConfig } from "@/lib/stores/config";
import { useFieldMode } from "@/lib/stores/settings";
import { MUTED, NAVY } from "@/theme/tokens";

const RED = "#D1382E";

/** The gel-squish settle: a soft, barely-overshooting spring (iOS Liquid Glass). */
const PRESS = { damping: 15, stiffness: 320, mass: 0.6 };
/** The menu drop — a touch looser so the panel eases open. */
const POP = { damping: 18, stiffness: 240, mass: 0.7 };

/**
 * The signed-in account chip (top right of the workspace screens): the staff
 * member's initials badge + a hamburger glyph on one **liquid-glass** pill — a
 * live BlurView backdrop with a specular top highlight, and a reanimated
 * press: the pill squishes on touch-down and a sheen brightens across the
 * glass, settling on release. Tapping it springs open a glass menu — Settings,
 * and Sign Out (confirmed) — anchored to the chip's measured frame so it lines
 * up whatever the screen's padding is.
 */
export function AccountMenu() {
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const router = useRouter();
  const { t } = useTranslation();
  const dark = useColorScheme().colorScheme === "dark";
  const field = useFieldMode();
  const admin = useConfig((s) => s.admin);
  const signOut = useConfig((s) => s.signOut);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const chipRef = useRef<View>(null);

  const name = admin?.displayName?.trim() || "Signed In";
  const role = admin?.role ? admin.role.replace(/_/g, " ") : "";

  // Glass recipe mirrors the tab bar so the chip reads as the same material.
  const glassDark = dark && !field;
  const glassFill = glassDark
    ? "rgba(255,255,255,0.06)"
    : field
      ? "rgba(255,255,255,0.88)"
      : "rgba(255,255,255,0.44)";
  const glassBorder = glassDark
    ? "rgba(255,255,255,0.12)"
    : field
      ? "rgba(9,27,84,0.24)"
      : "rgba(255,255,255,0.34)";
  const glassBlur = field ? 12 : glassDark ? 30 : 42;
  const iconColor = dark ? "rgba(255,255,255,0.86)" : "#42496A";

  // Press state → gel squish + sheen. One shared value drives both.
  const pressed = useSharedValue(0);
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(pressed.value, [0, 1], [1, 0.9]) }],
  }));
  const sheenStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pressed.value, [0, 1], [0, dark ? 0.22 : 0.45]),
  }));

  // The dropdown springs in from the chip rather than a flat cross-fade.
  const pop = useSharedValue(0);
  useEffect(() => {
    if (open) {
      pop.value = 0;
      pop.value = withSpring(1, POP);
    } else {
      pop.value = 0;
    }
  }, [open, pop]);
  const panelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pop.value, [0, 0.6], [0, 1], "clamp"),
    transform: [
      { scale: interpolate(pop.value, [0, 1], [0.9, 1]) },
      { translateY: interpolate(pop.value, [0, 1], [-8, 0]) },
    ],
  }));

  const openMenu = () => {
    // Anchor to the chip itself — the screens pad differently (20 phone /
    // 34 wide), so a fixed offset can't line up everywhere.
    chipRef.current?.measureInWindow((x, y, w, h) => {
      setAnchor({ top: y + h + 8, right: Math.max(screenW - (x + w), 12) });
      setOpen(true);
    });
    // measureInWindow never calls back if the view is gone; fall back visibly.
    setTimeout(() => setOpen((v) => (anchor === null ? true : v)), 80);
  };

  const onPeople = () => {
    setOpen(false);
    router.push("/people");
  };
  const onSettings = () => {
    setOpen(false);
    router.push("/settings");
  };
  const onSignOut = () => {
    setOpen(false);
    Alert.alert("Sign out?", `${name} will need to sign back in with ResMan credentials.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: () => void signOut() },
    ]);
  };

  return (
    <>
      <Animated.View style={[styles.chipShadow, pressStyle]}>
        <Pressable
          ref={chipRef}
          onPress={openMenu}
          onPressIn={() => {
            pressed.value = withSpring(1, PRESS);
          }}
          onPressOut={() => {
            pressed.value = withSpring(0, PRESS);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Account menu for ${name}`}
          style={[styles.chipClip, { borderColor: glassBorder, backgroundColor: glassFill }]}
        >
          {!field ? (
            <BlurView
              intensity={glassBlur}
              tint={glassDark ? "dark" : "light"}
              style={StyleSheet.absoluteFill}
            />
          ) : null}
          {/* Static specular: light catching the top curve of the glass. */}
          <View pointerEvents="none" style={styles.specular} />
          {/* Press sheen: the whole surface brightens on touch-down. */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, styles.sheen, sheenStyle]}
          />
          <View style={styles.chipContent}>
            <InitialsBadge name={name} size={32} />
            <Ionicons name="menu" size={22} color={iconColor} />
          </View>
        </Pressable>
      </Animated.View>

      <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => setOpen(false)}
          accessibilityLabel="Close menu"
        />
        <Animated.View
          style={[
            styles.panelShadow,
            { top: anchor?.top ?? insets.top + 56, right: anchor?.right ?? 20 },
            panelStyle,
          ]}
        >
          <View style={styles.panelClip}>
            <BlurView intensity={55} tint="light" style={styles.panelWash}>
              <View style={styles.header}>
                <InitialsBadge name={name} size={34} />
                <View style={styles.headerText}>
                  <Text numberOfLines={1} style={styles.name}>
                    {name}
                  </Text>
                  {role ? (
                    <Text numberOfLines={1} style={styles.role}>
                      {role.toUpperCase()}
                    </Text>
                  ) : null}
                </View>
              </View>
              <View style={styles.separator} />
              <Pressable onPress={onPeople} accessibilityRole="button" style={styles.row}>
                <View style={styles.rowIcon}>
                  <Ionicons name="people-outline" size={18} color={NAVY} />
                </View>
                <Text style={styles.rowLabel}>{t("people.title")}</Text>
                <Ionicons name="chevron-forward" size={14} color="rgba(9,27,84,0.30)" />
              </Pressable>
              <View style={styles.separatorInset} />
              <Pressable onPress={onSettings} accessibilityRole="button" style={styles.row}>
                <View style={styles.rowIcon}>
                  <Ionicons name="settings-outline" size={18} color={NAVY} />
                </View>
                <Text style={styles.rowLabel}>Settings</Text>
                <Ionicons name="chevron-forward" size={14} color="rgba(9,27,84,0.30)" />
              </Pressable>
              <View style={styles.separatorInset} />
              <Pressable onPress={onSignOut} accessibilityRole="button" style={styles.row}>
                <View style={styles.rowIcon}>
                  <Ionicons name="log-out-outline" size={18} color={RED} />
                </View>
                <Text style={[styles.rowLabel, { color: RED }]}>Sign Out</Text>
              </Pressable>
            </BlurView>
          </View>
        </Animated.View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  chipShadow: {
    borderRadius: 999,
    shadowColor: NAVY,
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  chipClip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    height: 44,
    paddingLeft: 6,
    paddingRight: 12,
    borderRadius: 999,
    overflow: "hidden",
    borderWidth: 1,
  },
  specular: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "52%",
    borderTopLeftRadius: 999,
    borderTopRightRadius: 999,
    backgroundColor: "rgba(255,255,255,0.28)",
  },
  sheen: {
    backgroundColor: "rgba(255,255,255,0.9)",
    borderRadius: 999,
  },
  chipContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  panelShadow: {
    position: "absolute",
    width: 252,
    borderRadius: 20,
    shadowColor: NAVY,
    shadowOpacity: 0.28,
    shadowRadius: 34,
    shadowOffset: { width: 0, height: 14 },
    elevation: 12,
  },
  panelClip: {
    borderRadius: 20,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(9,27,84,0.10)",
  },
  panelWash: {
    backgroundColor: "rgba(252,250,244,0.88)",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: 14.5,
    fontWeight: "800",
    color: NAVY,
    letterSpacing: -0.1,
  },
  role: {
    fontSize: 9.5,
    fontWeight: "700",
    color: MUTED,
    letterSpacing: 0.8,
    marginTop: 2,
  },
  separator: {
    height: 1,
    backgroundColor: "rgba(9,27,84,0.08)",
  },
  separatorInset: {
    height: 1,
    marginLeft: 54,
    backgroundColor: "rgba(9,27,84,0.06)",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 48,
    paddingHorizontal: 16,
  },
  rowIcon: {
    width: 26,
    alignItems: "flex-start",
  },
  rowLabel: {
    flex: 1,
    fontSize: 14.5,
    fontWeight: "600",
    color: NAVY,
    marginLeft: 6,
  },
});
