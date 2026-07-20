import { notFound } from "next/navigation";
import { getResmanLeaseDetail } from "@/lib/admin-resman-units";
import { LeaseDetailView } from "./lease-detail-view";

export const dynamic = "force-dynamic";

export default async function LeaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let detail: Awaited<ReturnType<typeof getResmanLeaseDetail>> = null;
  let error = "";
  try {
    detail = await getResmanLeaseDetail(id);
  } catch {
    error = "Failed to load this lease from the property-management mirror.";
  }

  if (error) {
    return (
      <div className="admin-page">
        <div className="card px-5 py-4">
          <p className="text-sm font-semibold text-red-600">{error}</p>
        </div>
      </div>
    );
  }
  if (!detail) notFound();

  return <LeaseDetailView detail={detail} />;
}
