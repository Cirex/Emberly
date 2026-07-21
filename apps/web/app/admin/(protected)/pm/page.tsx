import { redirect } from "next/navigation";
import { getAdminFromSessionCookie } from "@/lib/admin-request";
import { listPmOverview, type PmOverview } from "@/lib/pm-templates";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import { PmClient } from "./pm-client";

export const dynamic = "force-dynamic";

export default async function PreventiveMaintenancePage() {
  // Any authenticated admin can read the PM board; editing templates is
  // super_admin-only and gated per-control in the client (the API enforces it).
  const admin = await getAdminFromSessionCookie();
  if (!admin) redirect("/admin/login");

  let overview: PmOverview | null = null;
  let initialError = "";
  try {
    overview = await listPmOverview(createUntypedAdminClient());
  } catch (error) {
    console.error("[admin/pm page] Failed to load PM overview:", error);
    initialError = "Failed to load preventive maintenance templates.";
  }

  return (
    <PmClient
      initialOverview={overview}
      canManage={admin.role === "super_admin"}
      initialError={initialError}
    />
  );
}
