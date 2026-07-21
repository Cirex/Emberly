import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { BoardHeader } from "@/components/ui/BoardHeader";
import { screenHPad } from "@/theme/tokens";

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

/**
 * Wave-1 placeholder body for a manager tab: the real BoardHeader (single
 * inert mode, no metrics yet) over one empty-state card. Wave-2 feature
 * agents replace their screen's usage of this with the real board — the
 * header stays, gaining modes and metrics.
 */
export function PlaceholderBoard({ titleKey, icon }: { titleKey: string; icon: IoniconName }) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const [headerH, setHeaderH] = useState(0);
  const title = t(titleKey);

  return (
    <View style={{ flex: 1 }}>
      <BoardHeader
        modes={[{ key: "all", label: title, icon }]}
        activeMode="all"
        onMode={() => {}}
        metrics={[]}
        onHeight={setHeaderH}
      />
      <ScrollView
        contentContainerStyle={{
          paddingTop: headerH + 18,
          paddingHorizontal: screenHPad(width),
          paddingBottom: 120,
        }}
      >
        <AppCardSurface kind="panel" style={{ paddingHorizontal: 20, paddingVertical: 26, alignItems: "center", gap: 8 }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: "rgba(132,143,13,0.12)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name={icon} size={20} color="#848F0D" />
          </View>
          <Text className="text-navy dark:text-white" style={{ fontSize: 16, fontWeight: "700" }}>
            {t("placeholder.title")}
          </Text>
          <Text
            className="text-slate dark:text-white/60"
            style={{ fontSize: 12.5, textAlign: "center", lineHeight: 18 }}
          >
            {t("placeholder.body")}
          </Text>
        </AppCardSurface>
      </ScrollView>
    </View>
  );
}
