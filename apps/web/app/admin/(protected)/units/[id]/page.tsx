import { notFound } from "next/navigation";
import { getResmanUnitDetail } from "@/lib/admin-resman-units";
import { UnitDetailView } from "./unit-detail-view";

export const dynamic = "force-dynamic";

export default async function UnitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let detail: Awaited<ReturnType<typeof getResmanUnitDetail>> = null;
  let error = "";
  try {
    detail = await getResmanUnitDetail(id);
  } catch {
    error = "Failed to load this unit from the property-management mirror.";
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

  return <UnitDetailView detail={detail} />;
}
