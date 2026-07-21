import { Text, View } from "react-native";

/**
 * Circular initials badge with a stable per-name pastel palette (hash of the
 * name). Port of the maintenance app's TechBadge (components/work-orders/
 * rows.tsx), lifted into ui/ because here it is chrome (the AccountMenu chip),
 * not a work-order row ornament.
 */

const BADGE_PALETTES = [
  { bg: "#E4F0E2", fg: "#2C6B44", border: "#7FB98E" },
  { bg: "#E2EBF7", fg: "#2A5687", border: "#84A9D4" },
  { bg: "#F8ECDD", fg: "#9A5F1B", border: "#DCA96A" },
  { bg: "#EFE4F1", fg: "#6B3B78", border: "#C39BCB" },
  { bg: "#E8E6D1", fg: "#6B6420", border: "#BDB662" },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function InitialsBadge({ name, size = 25 }: { name: string; size?: number }) {
  const palette = BADGE_PALETTES[hashName(name) % BADGE_PALETTES.length];
  return (
    <View
      accessibilityLabel={name}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: palette.bg,
        borderWidth: 1.6,
        borderColor: palette.border,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: size * 0.38, fontWeight: "700", color: palette.fg }}>{initialsOf(name)}</Text>
    </View>
  );
}
