import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { Text, View } from "react-native";
import { GlassSurface } from "./GlassSurface";

interface AppMetricCardProps {
  icon: ComponentProps<typeof Ionicons>["name"];
  title: string;
  value: string;
  caption?: string;
}

/**
 * AppMetricCard (AppMetricCard.swift), glass variant: SF-symbol (light weight)
 * left, title (callout) / value (28 rounded semibold, tabular digits) / caption.
 * Radius 26.
 *
 * Really glass (blur + tint), not the plain translucent card surface — these
 * float over the tenant list and it scrolls beneath them.
 */
export function AppMetricCard({ icon, title, value, caption }: AppMetricCardProps) {
  return (
    <GlassSurface radius={26}>
      <View className="flex-row items-center" style={{ padding: 16, gap: 14 }}>
        <View
          className="items-center justify-center"
          style={{ width: 44, height: 44 }}
        >
          <Ionicons name={icon} size={32} color="#A2A921" />
        </View>
        <View className="flex-1">
          <Text className="text-slate dark:text-white/80" style={{ fontSize: 15, fontWeight: "500" }}>
            {title}
          </Text>
          <Text
            className="text-navy dark:text-white"
            style={{ fontSize: 28, fontWeight: "600", fontVariant: ["tabular-nums"] }}
          >
            {value}
          </Text>
          {caption ? (
            <Text className="text-muted" style={{ fontSize: 12 }}>
              {caption}
            </Text>
          ) : null}
        </View>
      </View>
    </GlassSurface>
  );
}
