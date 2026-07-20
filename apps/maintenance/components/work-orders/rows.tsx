import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Text, View } from "react-native";
import { classificationColor, workOrderStatusColor } from "@/lib/derived/status";
import { CALLBACK_TINT } from "@/theme/tokens";

/**
 * The structured two-line row language every work-order list shares (approved
 * mockup rev 3/5): an uppercase column-header strip, then per work order a
 * meta line in aligned columns and the full title beneath — wrapping, never
 * truncated mid-word.
 */

/** Grid template shared by header strip + meta rows so columns align. */
const ROW_COLS = { id: 62, status: 96 } as const;

export function ColumnHeader({ labels }: { labels: [string, string, string, string] }) {
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 8,
        paddingHorizontal: 14,
        paddingTop: 9,
        paddingBottom: 3,
        borderTopWidth: 1,
        borderTopColor: "rgba(9,27,84,0.08)",
      }}
    >
      <HeaderCell width={ROW_COLS.id} text={labels[0]} />
      <HeaderCell width={ROW_COLS.status} text={labels[1]} />
      <HeaderCell flex text={labels[2]} />
      <HeaderCell text={labels[3]} alignEnd />
    </View>
  );
}

function HeaderCell({
  text,
  width,
  flex,
  alignEnd,
}: {
  text: string;
  width?: number;
  flex?: boolean;
  alignEnd?: boolean;
}) {
  return (
    <Text
      className="text-muted dark:text-white/50"
      style={{
        width,
        flex: flex ? 1 : undefined,
        fontSize: 9.5,
        fontWeight: "700",
        letterSpacing: 0.8,
        textAlign: alignEnd ? "right" : "left",
      }}
    >
      {text.toUpperCase()}
    </Text>
  );
}

export function StatusText({ status, size = 11.5 }: { status: string; size?: number }) {
  return (
    <Text numberOfLines={1} style={{ fontSize: size, fontWeight: "600", color: workOrderStatusColor(status) }}>
      {status}
    </Text>
  );
}

export function ClassificationChip({ classification }: { classification: string }) {
  if (!classification || classification === "—") return null;
  const color = classificationColor(classification);
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 1.5,
        borderRadius: 999,
        backgroundColor: `${color}1A`,
        borderWidth: 1,
        borderColor: `${color}47`,
      }}
    >
      <Text style={{ fontSize: 9.5, fontWeight: "700", color }}>{classification}</Text>
    </View>
  );
}

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

/** Circular initials badge, per-technician color (stable hash of the name). */
export function TechBadge({ name, size = 25 }: { name: string; size?: number }) {
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

/**
 * One work order, two decorative lines: aligned meta columns on top (ID with
 * optional signal glyph, status, middle slot, trailing slot), then the full
 * wrapping title.
 */
export function WorkOrderRow({
  number,
  status,
  title,
  middle,
  trailing,
  signal,
}: {
  number: string;
  status: string;
  title: string;
  middle?: React.ReactNode;
  trailing?: string;
  signal?: "callback" | "duplicate" | null;
}) {
  return (
    <View
      style={{
        paddingHorizontal: 14,
        paddingTop: 11,
        paddingBottom: 12,
        borderTopWidth: 1,
        borderTopColor: "rgba(9,27,84,0.06)",
      }}
    >
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <View style={{ width: ROW_COLS.id, flexDirection: "row", alignItems: "center", gap: 4 }}>
          {signal === "callback" ? (
            <MaterialCommunityIcons name="arrow-u-left-top" size={12} color={CALLBACK_TINT} />
          ) : signal === "duplicate" ? (
            <MaterialCommunityIcons name="content-duplicate" size={12} color="#2563B4" />
          ) : null}
          <Text
            className="text-navy dark:text-white"
            numberOfLines={1}
            style={{ fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] }}
          >
            {number}
          </Text>
        </View>
        <View style={{ width: ROW_COLS.status }}>
          <StatusText status={status} />
        </View>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 5 }}>{middle}</View>
        {trailing ? (
          <Text
            className="text-muted dark:text-white/60"
            style={{ fontSize: 11, fontVariant: ["tabular-nums"] }}
          >
            {trailing}
          </Text>
        ) : null}
      </View>
      <Text
        className="text-navy dark:text-white"
        style={{ fontSize: 14, fontWeight: "600", lineHeight: 19, marginTop: 5 }}
      >
        {title || "Untitled work order"}
      </Text>
    </View>
  );
}
