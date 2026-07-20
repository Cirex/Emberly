import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";
import { MUTED, OLIVE_TEXT } from "@/theme/tokens";

/**
 * Markdown-lite — the tiny subset the maintenance team actually writes:
 * #/## headings, -/* bullets, [ ]/[x] checkboxes, **bold** runs. Shared by
 * the detail screen's sections and the editor's Preview mode (which passes
 * `onToggleLine` so tapping a checkbox flips [ ] ⇄ [x] in the source).
 */

export function InlineBold({
  text,
  base,
}: {
  text: string;
  base: { fontSize: number; fontWeight?: "400" | "700"; color: string; lineHeight?: number };
}) {
  const parts = text.split("**");
  return (
    <Text style={{ fontWeight: "400", ...base }}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={{ fontWeight: "700" }}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

export function MarkdownLite({
  text,
  ink,
  onToggleLine,
}: {
  text: string;
  ink: string;
  /** Present = checkboxes are tappable; called with the 0-based source line. */
  onToggleLine?: (lineIndex: number) => void;
}) {
  const BODY = { fontSize: 13, color: ink, lineHeight: 19.5 } as const;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return (
    <View style={{ gap: 2 }}>
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return <View key={i} style={{ height: 6 }} />;

        if (trimmed.startsWith("## ")) {
          return (
            <InlineBold
              key={i}
              text={trimmed.slice(3)}
              base={{ fontSize: 13, fontWeight: "700", color: ink }}
            />
          );
        }
        if (trimmed.startsWith("# ")) {
          return (
            <InlineBold
              key={i}
              text={trimmed.slice(2)}
              base={{ fontSize: 14, fontWeight: "700", color: ink }}
            />
          );
        }

        const checkbox = trimmed.match(/^(?:[-*]\s+)?\[( |x|\*)\]\s*(.*)$/i);
        if (checkbox) {
          const checked = checkbox[1] !== " ";
          const row = (
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
              <Ionicons
                name={checked ? "checkbox-outline" : "square-outline"}
                size={13}
                color={checked ? OLIVE_TEXT : MUTED}
                style={{ marginTop: 3 }}
              />
              <View style={{ flex: 1 }}>
                <InlineBold text={checkbox[2]} base={BODY} />
              </View>
            </View>
          );
          return onToggleLine ? (
            <Pressable
              key={i}
              onPress={() => onToggleLine(i)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              hitSlop={4}
            >
              {row}
            </Pressable>
          ) : (
            <View key={i}>{row}</View>
          );
        }

        const bullet = trimmed.match(/^[-*]\s+(.*)$/);
        if (bullet) {
          return (
            <View key={i} style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
              <Text style={{ ...BODY, color: MUTED }}>•</Text>
              <View style={{ flex: 1 }}>
                <InlineBold text={bullet[1]} base={BODY} />
              </View>
            </View>
          );
        }

        return <InlineBold key={i} text={line} base={BODY} />;
      })}
    </View>
  );
}
