import { redirect } from "next/navigation";
import { getAdminFromSessionCookie } from "@/lib/admin-request";
import { listAdminUsers, type AdminUserSummary } from "@/lib/admin-users";
import { createUntypedAdminClient } from "@/lib/supabase/admin";
import { AdminUsersClient } from "./users-client";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  // Managing roles must itself be a privileged act. The layout already bounces
  // non-admins; here we additionally require super_admin and send a lower-privi-
  // leged admin back to the dashboard rather than showing the roster.
  const admin = await getAdminFromSessionCookie();
  if (!admin) redirect("/admin/login");
  if (admin.role !== "super_admin") redirect("/admin");

  let users: AdminUserSummary[] = [];
  let initialError = "";
  try {
    const client = createUntypedAdminClient();
    users = await listAdminUsers(client);
  } catch (error) {
    console.error("[admin/users page] Failed to load admin users:", error);
    initialError = "Failed to load admin users.";
  }

  return <AdminUsersClient initialUsers={users} currentAdminId={admin.adminId} initialError={initialError} />;
}
