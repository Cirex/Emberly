/// <reference path="../nativewind-shim.d.ts" />
import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { Text, View } from "react-native";

interface AppStatusBadgeProps {
  label: string;
  /** Tint hex (e.g. STATUS_TINT.ready). Drives fg, fill@12%, stroke@25%. */
  tint: string;
  icon?: ComponentProps<typeof Ionicons>["name"];
}

/** Hex → rgba with alpha. */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * AppStatusBadge (AppStatusBadge.swift): capsule, icon+text 12 semibold in the
 * tint, fill tint@12%, 1px stroke tint@25%, padding H9 V5.
 */
export function AppStatusBadge({ label, tint, icon }: AppStatusBadgeProps) {
  return (
    <View
      className="flex-row items-center self-start"
      style={{
        gap: 6,
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: withAlpha(tint, 0.25),
        backgroundColor: withAlpha(tint, 0.12),
      }}
    >
      {icon ? <Ionicons name={icon} size={12} color={tint} /> : null}
      <Text style={{ color: tint, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}
