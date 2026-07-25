import { useRouter } from "expo-router";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import type { ClosedWorkOrderRow } from "@/lib/derived/closed-rows";
import { statusLabel } from "@/lib/derived/resman-labels";
import { tagTint } from "@/lib/derived/tags";
import { MUTED } from "@/theme/tokens";
import { useTranslated } from "@/lib/translation/use-translated";

/**
 * A closed work order, per the 2026-07-21 design pass.
 *
 * COLUMN ORDER MATCHES THE OPEN BOARD'S TICKET ROWS: number + date lead, the
 * technician's initials trail. The design pass had these reversed, which read
 * fine in isolation but meant the two boards put the same two facts on opposite
 * sides of the row — so moving between tabs re-taught your eye where to look.
 * The initials keep their stable per-tech tint; only the side changed.
 *
 * NO STATUS CHIP. Every row here is closed, so status is the least interesting
 * thing about it — the exception (canceled) is chipped inline instead.
 *
 * NO STRIKETHROUGH. My Day strikes done stops because it contrasts them against
 * pending ones. On a board that is 100% closed, strikethrough is pure friction.
 *
 * NO SYNC LINE. "Closed by … · syncing to ResMan" belongs to My Day's
 * pending-close recap, where work is still in flight. Everything here is already
 * in ResMan; repeating it thousands of times is noise.
 */

const CALLBACK = "#D4537E";

/**
 * A stable colour per technician, so the same person reads the same on every
 * visit. HASHED from the name rather than assigned by list position — position
 * shifts as work closes, and a colour that moves is worse than no colour.
 */
const TECH_TINTS = ["#767B24", "#2563B4", "#0E7D7D", "#8348B5", "#B05E14", "#9C101F"];
function techTint(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return TECH_TINTS[Math.abs(hash) % TECH_TINTS.length];
}

/** Chip shared by the trade tag, the days-to-close figure and the callback mark. */
function Tag({ label, color }: { label: string; color: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2.5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: `${color}40`,
        backgroundColor: `${color}12`,
      }}
    >
      <Text style={{ fontSize: 9, fontWeight: "700", color }}>{label}</Text>
    </View>
  );
}

/**
 * Memoized: the board can hold thousands of rows, and any parent re-render (a
 * sync tick bumping dataVersion, a filter change) would otherwise re-render
 * every mounted one. Rows come from the derived snapshot and are referentially
 * stable while it is, so this is a real cutoff.
 */
export const ClosedRow = memo(function ClosedRow({
  row,
  today = false,
}: {
  row: ClosedWorkOrderRow;
  /** Today's rows carry a faint green wash — My Day's "fresh" treatment. */
  today?: boolean;
}) {
  const router = useRouter();
  const { t } = useTranslation();
  const tr = useTranslated();
  const tint = techTint(row.technicianDisplay);
  // Canceled work is not a closure. Flag it rather than let it read as done.
  const canceled = /^cancell?ed$/i.test(row.status);

  return (
    <Pressable
      onPress={() => router.push(`/work-order/${row.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${row.unitNumber} · ${row.title}`}
      style={{
        flexDirection: "row",
        gap: 10,
        paddingHorizontal: 18,
        paddingVertical: 11,
        alignItems: "flex-start",
        borderTopWidth: 1,
        borderTopColor: "rgba(9,27,84,0.08)",
        backgroundColor: today ? "rgba(51,166,102,0.05)" : "transparent",
      }}
    >
      {/* Leading meta column, fixed width so numbers and dates line up down the
          list rather than ragging against the titles. Open's ticket rows use
          the same stack: number first, date beneath. */}
      <View style={{ width: 58, flexShrink: 0 }}>
        <Text
          className="text-muted dark:text-white/50"
          style={{ fontSize: 10, fontWeight: "800", fontVariant: ["tabular-nums"] }}
        >
          #{row.number}
        </Text>
        <Text
          className="text-slate dark:text-white/60"
          style={{
            fontSize: 9.5,
            fontWeight: "700",
            marginTop: 1,
            opacity: 0.85,
            fontVariant: ["tabular-nums"],
          }}
        >
          {row.dateCompletedText}
        </Text>
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          className="text-navy dark:text-white"
          numberOfLines={2}
          style={{ fontSize: 13, fontWeight: "700", lineHeight: 17.5 }}
        >
          <Text style={{ fontWeight: "800" }}>{row.unitNumber}</Text>
          {" · "}
          {tr(row.title).shown || t("workOrders.untitled")}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
          {canceled ? <Tag label={statusLabel(t, row.status)} color={CALLBACK} /> : null}
          {row.tradeTag ? <Tag label={row.tradeTag} color={tagTint(row.tradeTag)} /> : null}
          {row.isCallback ? <Tag label={t("workOrders.closed.callback")} color={CALLBACK} /> : null}
          {row.daysToCloseLabel ? <Tag label={row.daysToCloseLabel} color={MUTED} /> : null}
        </View>
      </View>

      {/* Trailing slot keeps its width when there is no technician, so the right
          edge stays a straight line. Unassigned work draws no circle — an
          em-dash in a tinted badge says less than nothing. */}
      <View style={{ width: 26, flexShrink: 0, marginTop: 1 }}>
        {row.technicianInitials ? (
          <View
            accessibilityLabel={row.technicianDisplay}
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: `${tint}59`,
              backgroundColor: `${tint}24`,
            }}
          >
            <Text style={{ fontSize: 9.5, fontWeight: "800", color: tint }}>
              {row.technicianInitials}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

/** Timeline band header — "TODAY · 2". */
export const ClosedBand = memo(function ClosedBand({
  label,
  count,
}: {
  label: string;
  count: number;
}) {
  return (
    <View
      style={{
        paddingHorizontal: 18,
        paddingTop: 14,
        paddingBottom: 5,
        backgroundColor: "rgba(246,244,238,0.96)",
      }}
    >
      <Text
        style={{
          fontSize: 10,
          fontWeight: "700",
          letterSpacing: 1,
          color: MUTED,
          fontVariant: ["tabular-nums"],
        }}
      >
        {label.toUpperCase()}
        {count > 0 ? ` · ${count.toLocaleString()}` : ""}
      </Text>
    </View>
  );
});

/** Quiet incremental-render footer — the smart-scroll affordance. */
export function LoadingMoreFooter({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingVertical: 14,
      }}
    >
      {[0.9, 0.55, 0.3].map((opacity, i) => (
        <View
          key={i}
          style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: MUTED, opacity }}
        />
      ))}
      <Text className="text-muted" style={{ fontSize: 10.5, fontWeight: "600" }}>
        {t("workOrders.loadingMore")}
      </Text>
    </View>
  );
}
