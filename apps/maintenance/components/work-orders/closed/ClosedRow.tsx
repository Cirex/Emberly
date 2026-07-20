import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { ClassificationChip, WorkOrderRow } from "@/components/work-orders/rows";
import type { ClosedWorkOrderRow } from "@/lib/derived/closed-rows";
import { MUTED } from "@/theme/tokens";

/**
 * One closed work order in the structured two-line language: ID · status ·
 * unit + classification · completed date + days-to-close, then the full title.
 */
export function ClosedRow({ row }: { row: ClosedWorkOrderRow }) {
  const router = useRouter();
  return (
    <Pressable onPress={() => router.push(`/work-order/${row.id}`)}>
      <WorkOrderRow
        number={row.number}
        status={row.status}
        title={row.title}
        middle={
          <>
            <Text className="text-muted dark:text-white/60" numberOfLines={1} style={{ fontSize: 11.5 }}>
              {row.unitNumber}
            </Text>
            <ClassificationChip classification={row.classification} />
          </>
        }
        trailing={
          row.daysToComplete >= 0 ? `${row.dateCompletedText} · ${row.daysToCompleteText}d` : row.dateCompletedText
        }
      />
    </Pressable>
  );
}

/** Quiet incremental-render footer — the smart-scroll affordance. */
export function LoadingMoreFooter({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 14 }}>
      {[0.9, 0.55, 0.3].map((opacity, i) => (
        <View key={i} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: MUTED, opacity }} />
      ))}
      <Text className="text-muted" style={{ fontSize: 10.5, fontWeight: "600" }}>
        Loading more…
      </Text>
    </View>
  );
}
