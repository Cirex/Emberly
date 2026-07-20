import { redirect } from "next/navigation";
import { AdminShell } from "./_components/admin-shell";
import { getAdminFromSessionCookie } from "@/lib/admin-request";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // getAdminFromSessionCookie re-checks the live admin_users row (active + role),
  // so a deactivated/downgraded admin is bounced even mid-session.
  const admin = await getAdminFromSessionCookie();

  if (!admin) {
    redirect("/admin/login");
  }

  return (
    <AdminShell adminName={admin.displayName} adminRole={admin.role}>
      {children}
    </AdminShell>
  );
}
