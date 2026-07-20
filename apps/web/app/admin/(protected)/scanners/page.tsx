import { listAdminScanners, type AdminScanner } from "@/lib/admin-scanners";
import { getScannerScanCountsToday } from "@/lib/admin-scanner-activity";
import { ScannersClient } from "./scanners-client";

export const dynamic = "force-dynamic";

export default async function ScannersPage() {
  let scanners: AdminScanner[] = [];
  let scanCounts: Record<string, number> = {};
  let initialError = "";

  try {
    [scanners, scanCounts] = await Promise.all([
      listAdminScanners(),
      getScannerScanCountsToday(),
    ]);
  } catch (error) {
    console.error("[admin/scanners page] Failed to load scanners:", error);
    initialError = "Failed to load scanners";
  }

  return (
    <ScannersClient
      initialScanners={scanners}
      initialError={initialError}
      scanCounts={scanCounts}
    />
  );
}
