import { format, subDays } from "date-fns";
import { listAdminEntryLogs, type EntryLog } from "@/lib/admin-entry-logs";
import type { AdminPagination } from "@/lib/admin-guest-passes";
import { getScannerNameMap } from "@/lib/admin-scanners";
import { EntryLogsClient } from "./entry-logs-client";

export default async function EntryLogsPage() {
  const initialFrom = format(subDays(new Date(), 7), "yyyy-MM-dd");
  const initialTo = format(new Date(), "yyyy-MM-dd");
  let logs: EntryLog[] = [];
  let pagination: AdminPagination | null = null;
  let scannerNames: Record<string, string> = {};
  let initialError = "";

  try {
    const [result, names] = await Promise.all([
      listAdminEntryLogs({
        from: `${initialFrom}T00:00:00Z`,
        to: `${initialTo}T23:59:59Z`,
      }),
      getScannerNameMap(),
    ]);
    logs = result.logs;
    pagination = result.pagination;
    scannerNames = names;
  } catch (error) {
    console.error("[admin/entry-logs page] Failed to load entry logs:", error);
    initialError = "Failed to load entry logs";
  }

  return (
    <EntryLogsClient
      initialLogs={logs}
      initialPagination={pagination}
      initialError={initialError}
      initialFrom={initialFrom}
      initialTo={initialTo}
      scannerNames={scannerNames}
    />
  );
}
