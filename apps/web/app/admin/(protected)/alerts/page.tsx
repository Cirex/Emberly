import { listAdminAlerts, type AdminAlert } from "@/lib/admin-alerts";
import { AlertsClient } from "./alerts-client";

export default async function AlertsPage() {
  let alerts: AdminAlert[] = [];
  let initialError = "";

  try {
    alerts = await listAdminAlerts("open");
  } catch (error) {
    console.error("[admin/alerts page] Failed to load alerts:", error);
    initialError = "Failed to load alerts";
  }

  return <AlertsClient initialAlerts={alerts} initialError={initialError} />;
}
