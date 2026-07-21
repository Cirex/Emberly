import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import type { ScoreCard } from "@/lib/derived/score-cards";
import { HAIRLINE } from "@/theme/tokens";

/**
 * The four per-mode metrics, Option 2 treatment: no card surfaces — bare
 * numbers sitting directly on the backdrop in a hairline-divided grid (2×2 on
 * phone, one row of four at tablet width; never a horizontal scroll).
 * Numbers carry each card's tint (the My Day metric treatment — one anatomy
 * with the GlassHeader strip). Interactive cells keep their tap → analytics
 * overlay, signposted by a quiet chevron in the corner.
 */
export function ScoreCardGrid({
  cards,
  onAction,
}: {
  cards: ScoreCard[];
  onAction: (action: NonNullable<ScoreCard["action"]>) => void;
}) {
  const { width } = useWindowDimensions();
  const columns = width >= 768 ? 4 : 2;

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
      {cards.map((card, i) => {
        const col = i % columns;
        const row = Math.floor(i / columns);
        return (
          <Pressable
            key={card.key}
            disabled={!card.interactive || card.action === null}
            onPress={() => card.action && onAction(card.action)}
            accessibilityRole={card.interactive ? "button" : undefined}
            style={{
              flexBasis: `${100 / columns}%`,
              paddingVertical: 11,
              paddingLeft: col === 0 ? 0 : 16,
              paddingRight: 6,
              borderLeftWidth: col === 0 ? 0 : 1,
              borderLeftColor: HAIRLINE,
              borderTopWidth: row === 0 ? 0 : 1,
              borderTopColor: HAIRLINE,
            }}
          >
            {card.interactive ? (
              <Ionicons
                name="chevron-forward"
                size={11}
                color="rgba(9,27,84,0.28)"
                style={{ position: "absolute", top: 12, right: 8 }}
              />
            ) : null}
            <Text
              style={{ fontSize: 24, fontWeight: "800", letterSpacing: -0.5, fontVariant: ["tabular-nums"], lineHeight: 28, color: card.tint }}
            >
              {card.value}
            </Text>
            <Text
              className="text-slate dark:text-white/70"
              numberOfLines={1}
              style={{ fontSize: 10.5, fontWeight: "600", marginTop: 2 }}
            >
              {card.title}
            </Text>
            <Text className="text-muted dark:text-white/50" numberOfLines={1} style={{ fontSize: 9.5, marginTop: 1 }}>
              {card.caption}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
