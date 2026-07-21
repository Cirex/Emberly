import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";
import { AppCardSurface } from "@/components/ui/AppCardSurface";

export interface LegendRow {
  label: string;
  color: string;
  /** Optional live count shown after the label (groups lens). */
  count?: number;
}

/**
 * The floating legend card (mockup's `maplegend`): a quiet glass card listing
 * the active lens's swatches — the heat ramp bands or the visible leasing
 * groups with their live counts — plus an optional edit affordance for the
 * groups lens.
 */
export function LegendCard({
  title,
  rows,
  onEdit,
  editLabel,
}: {
  title: string;
  rows: LegendRow[];
  /** When present, renders a small edit row that opens the groups sheet. */
  onEdit?: () => void;
  editLabel?: string;
}) {
  return (
    <AppCardSurface kind="row" style={{ borderRadius: 12 }}>
      <View style={{ paddingHorizontal: 11, paddingVertical: 9, gap: 5, minWidth: 118 }}>
        <Text
          className="text-navy dark:text-white"
          style={{ fontSize: 10, fontWeight: "800", letterSpacing: 0.3, marginBottom: 1 }}
        >
          {title}
        </Text>
        {rows.map((r) => (
          <View key={r.label} className="flex-row items-center" style={{ gap: 6 }}>
            <View
              style={{
                width: 12,
                height: 9,
                borderRadius: 2,
                backgroundColor: r.color,
                borderWidth: 1,
                borderColor: "rgba(9,27,84,0.15)",
              }}
            />
            <Text
              className="text-slate dark:text-white/70"
              style={{ flex: 1, fontSize: 10.5, fontWeight: "600" }}
              numberOfLines={1}
            >
              {r.label}
            </Text>
            {typeof r.count === "number" ? (
              <Text
                className="text-slate dark:text-white/55"
                style={{ fontSize: 10.5, fontWeight: "800", fontVariant: ["tabular-nums"] }}
              >
                {r.count}
              </Text>
            ) : null}
          </View>
        ))}
        {onEdit ? (
          <Pressable
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel={editLabel}
            className="flex-row items-center"
            style={{ gap: 4, marginTop: 3 }}
            hitSlop={6}
          >
            <Ionicons name="options-outline" size={11} color="#767B24" />
            <Text style={{ fontSize: 10.5, fontWeight: "700", color: "#767B24" }}>{editLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </AppCardSurface>
  );
}
