import { listAdminResidents, type AdminResident } from "@/lib/admin-residents";
import { ResidentsClient } from "./residents-client";

export default async function ResidentsPage() {
  let residents: AdminResident[] = [];
  let initialError = "";

  try {
    residents = await listAdminResidents();
  } catch (err) {
    console.error("[admin/residents page] Failed to load residents:", err);
    initialError = "Failed to load residents";
  }

  return <ResidentsClient initialResidents={residents} initialError={initialError} />;
}
