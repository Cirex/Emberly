import {
  getResmanWorkOrders,
  type WorkOrderStatusFilter,
  type WorkOrdersResult,
} from "@/lib/admin-resman-work-orders";
import { WorkOrdersClient } from "./work-orders-client";

export const dynamic = "force-dynamic";

const STATUS_FILTERS = new Set<WorkOrderStatusFilter>(["open", "completed", "canceled", "all"]);

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function WorkOrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const str = (key: string) => (typeof sp[key] === "string" ? (sp[key] as string) : "");

  const statusRaw = str("status");
  const status = STATUS_FILTERS.has(statusRaw as WorkOrderStatusFilter)
    ? (statusRaw as WorkOrderStatusFilter)
    : "open";
  const category = str("category");
  const technician = str("tech");
  const search = str("search");
  const aging = str("aging") === "31plus";
  const page = Math.max(1, Number.parseInt(str("page"), 10) || 1);

  let result: WorkOrdersResult | null = null;
  let initialError = "";
  try {
    result = await getResmanWorkOrders({ status, category, technician, search, aging, page, limit: 100 });
  } catch (error) {
    console.error("[admin/work-orders page] Failed to load:", error);
    initialError = "Failed to load work orders from the property-management mirror.";
  }

  return (
    <WorkOrdersClient
      result={result}
      status={status}
      category={category}
      technician={technician}
      search={search}
      aging={aging}
      page={page}
      initialError={initialError}
    />
  );
}
