import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import type { MapLens } from "@/lib/stores/map-lens";

/**
 * The lens pill row (mockup's `mappill`), bottom-left over the map:
 * Heat · Groups · Utilities. Tapping the active pill turns the lens off
 * (back to the bare plan). Utilities is present but disabled — the cross-app
 * utility layer hasn't landed in the manager yet — and answers a tap with a
 * transient "coming soon" hint instead of dead silence.
 */
function Pill({
  label,
  active,
  disabled,
  onPress,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      style={{
        paddingHorizontal: 13,
        paddingVertical: 7,
        borderRadius: 999,
        backgroundColor: active ? "rgba(162,169,33,0.92)" : "transparent",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        className={active ? undefined : "text-navy dark:text-white/80"}
        style={{ fontSize: 12, fontWeight: "800", color: active ? "#FFFFFF" : undefined }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function LensPills({
  lens,
  onSelect,
}: {
  lens: MapLens;
  /** Called with the tapped lens, or "none" when the active pill is re-tapped. */
  onSelect: (lens: MapLens) => void;
}) {
  const { t } = useTranslation();
  const [showSoon, setShowSoon] = useState(false);
  const soonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (soonTimer.current) clearTimeout(soonTimer.current);
    },
    [],
  );

  const onUtilities = () => {
    setShowSoon(true);
    if (soonTimer.current) clearTimeout(soonTimer.current);
    soonTimer.current = setTimeout(() => setShowSoon(false), 1800);
  };

  return (
    <View style={{ alignItems: "flex-start", gap: 6 }}>
      {showSoon ? (
        <View
          className="bg-navy"
          style={{ borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, opacity: 0.92 }}
        >
          <Text style={{ color: "#FFFFFF", fontSize: 11, fontWeight: "600" }}>
            {t("map.lens.utilitiesSoon")}
          </Text>
        </View>
      ) : null}
      <AppCardSurface kind="row" style={{ borderRadius: 999 }}>
        <View className="flex-row items-center" style={{ padding: 3, gap: 2 }}>
          <Pill
            label={t("map.lens.heat")}
            active={lens === "heat"}
            onPress={() => onSelect(lens === "heat" ? "none" : "heat")}
          />
          <Pill
            label={t("map.lens.groups")}
            active={lens === "groups"}
            onPress={() => onSelect(lens === "groups" ? "none" : "groups")}
          />
          <Pill label={t("map.lens.utilities")} disabled onPress={onUtilities} />
        </View>
      </AppCardSurface>
    </View>
  );
}
