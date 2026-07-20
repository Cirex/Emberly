import type { ReactNode } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppScreenHeader } from "./AppScreenHeader";

interface ScreenScaffoldProps {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  children?: ReactNode;
}

/**
 * Common screen frame: warm backdrop shows through, safe-area top inset,
 * responsive horizontal padding (24 → 34 at ≥1040pt, per TenantsDashboard),
 * and bottom room for the floating tab bar.
 */
export function ScreenScaffold({ title, subtitle, trailing, children }: ScreenScaffoldProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const hPad = width >= 1040 ? 34 : 24;

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: insets.top + 26,
        paddingHorizontal: hPad,
        paddingBottom: insets.bottom + 96,
        gap: 18,
      }}
      showsVerticalScrollIndicator={false}
    >
      <AppScreenHeader title={title} subtitle={subtitle} trailing={trailing} />
      <View style={{ gap: 12 }}>{children}</View>
    </ScrollView>
  );
}
