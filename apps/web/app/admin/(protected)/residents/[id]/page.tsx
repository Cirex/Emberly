import { getAdminResidentDetail } from "@/lib/admin-resident-detail";
import { getScannerNameMap } from "@/lib/admin-scanners";
import { ResidentDetailClient } from "./resident-detail-client";

type ResidentDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ResidentDetailPage({ params }: ResidentDetailPageProps) {
  const { id } = await params;
  let detail = null;
  let scannerNames: Record<string, string> = {};
  let initialError = "";

  try {
    const [d, names] = await Promise.all([getAdminResidentDetail(id), getScannerNameMap()]);
    detail = d;
    scannerNames = names;
    initialError = detail ? "" : "Resident not found.";
  } catch (error) {
    console.error("[admin/resident detail page] Failed to load resident:", error);
    initialError = "Failed to load resident detail.";
  }

  return (
    <ResidentDetailClient
      residentId={id}
      initialDetail={detail}
      initialError={initialError}
      scannerNames={scannerNames}
    />
  );
}
