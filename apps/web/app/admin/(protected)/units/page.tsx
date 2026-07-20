import {
  listResmanUnits,
  type ResmanOccupancy,
  type ResmanUnitsResult,
} from "@/lib/admin-resman-units";
import { UnitsClient } from "./units-client";

export const dynamic = "force-dynamic";

const OCCUPANCIES = new Set<ResmanOccupancy>(["Occupied", "Vacant", "Notice"]);

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function UnitsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const str = (key: string) => (typeof sp[key] === "string" ? (sp[key] as string) : "");

  const occRaw = str("occupancy");
  const occupancy = OCCUPANCIES.has(occRaw as ResmanOccupancy) ? (occRaw as ResmanOccupancy) : undefined;
  const classification = str("class");
  const hasBalance = str("balance") === "1";
  const search = str("search");
  const page = Math.max(1, Number.parseInt(str("page"), 10) || 1);

  let result: ResmanUnitsResult | null = null;
  let initialError = "";
  try {
    result = await listResmanUnits({ occupancy, classification, hasBalance, search, page, limit: 100 });
  } catch (error) {
    console.error("[admin/units page] Failed to load units:", error);
    initialError = "Failed to load units from the property-management mirror.";
  }

  return (
    <UnitsClient
      result={result}
      occupancy={occupancy ?? "all"}
      classification={classification}
      hasBalance={hasBalance}
      search={search}
      page={page}
      initialError={initialError}
    />
  );
}
