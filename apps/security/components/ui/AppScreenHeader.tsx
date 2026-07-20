import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { EmberlyBrandLogo } from "@emberly/ui";

interface AppScreenHeaderProps {
  title: string;
  subtitle?: string;
  /** Trailing controls (search, filter, refresh…). */
  trailing?: ReactNode;
}

/** Sized to stand beside the title + subtitle stack rather than above it. */
const MARK_SIZE = 64;

/**
 * AppScreenHeader (AppScreenHeader.swift): brand mark beside title (34 bold navy)
 * over subtitle (16 medium slate), with optional trailing controls.
 *
 * The mark alone, not the full lockup — the real stacked artwork would render its
 * wordmark at a few unreadable pixels at this size.
 *
 * Trailing controls sit at the top of the row, not the bottom: they belong to the
 * screen rather than to the subtitle, and aligning them to the baseline of a
 * two-line heading dropped them into the middle of the page.
 */
export function AppScreenHeader({ title, subtitle, trailing }: AppScreenHeaderProps) {
  return (
    <View className="flex-row items-start justify-between" style={{ gap: 16 }}>
      <View className="flex-row items-center" style={{ gap: 14, flexShrink: 1 }}>
        <EmberlyBrandLogo variant="flower" size={MARK_SIZE} />
        <View style={{ gap: 5, flexShrink: 1 }}>
          <Text
            className="text-navy dark:text-white"
            style={{ fontSize: 34, fontWeight: "700" }}
            numberOfLines={1}
            minimumFontScale={0.82}
            adjustsFontSizeToFit
          >
            {title}
          </Text>
          {subtitle ? (
            <Text className="text-slate dark:text-white/70" style={{ fontSize: 16, fontWeight: "500" }}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {trailing ? <View className="flex-row items-center" style={{ gap: 12 }}>{trailing}</View> : null}
    </View>
  );
}
