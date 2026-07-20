import { listAdminGuestPasses } from "@/lib/admin-guest-passes";
import type { AdminPagination, GuestPassRow } from "@/lib/admin-guest-passes";
import { GuestPassesClient } from "./guest-passes-client";

export default async function GuestPassesPage() {
  let passes: GuestPassRow[] = [];
  let pagination: AdminPagination | null = null;
  let initialError = "";

  try {
    const result = await listAdminGuestPasses();
    passes = result.passes;
    pagination = result.pagination;
  } catch (error) {
    console.error("[admin/guest-passes page] Failed to load guest passes:", error);
    initialError = "Failed to load guest passes";
  }

  return (
    <GuestPassesClient
      initialPasses={passes}
      initialPagination={pagination}
      initialError={initialError}
    />
  );
}
