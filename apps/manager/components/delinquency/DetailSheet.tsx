import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MONEY_COLORS } from "@/components/delinquency/bits";

/**
 * Phone bottom-sheet chrome for the Money board's detail views: a slide-up
 * modal with grabber, title row, and a scrollable body. On iPad (>=1040) the
 * screen renders the same children in the split's right pane instead — this
 * component is the phone presentation only.
 */
export function DetailSheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(9,27,84,0.25)" }]}
        onPress={onClose}
        accessibilityLabel="Close"
      />
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: "88%",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          backgroundColor: "rgba(250,247,240,0.99)",
          shadowColor: MONEY_COLORS.navy,
          shadowOpacity: 0.12,
          shadowRadius: 30,
          shadowOffset: { width: 0, height: -8 },
          paddingBottom: Math.max(insets.bottom, 16),
        }}
      >
        <View
          style={{
            alignSelf: "center",
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: "rgba(9,27,84,0.15)",
            marginTop: 8,
          }}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, paddingTop: 12 }}>
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: MONEY_COLORS.navy }}
          >
            {title}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              backgroundColor: "rgba(9,27,84,0.06)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="close" size={14} color={MONEY_COLORS.slate} />
          </Pressable>
        </View>
        {subtitle ? (
          <Text style={{ paddingHorizontal: 18, paddingTop: 2, fontSize: 10.5, color: MONEY_COLORS.muted }}>
            {subtitle}
          </Text>
        ) : null}
        <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>{children}</ScrollView>
      </View>
    </Modal>
  );
}
