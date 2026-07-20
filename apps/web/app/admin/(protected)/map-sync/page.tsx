import { redirect } from "next/navigation";
import { getAdminFromSessionCookie } from "@/lib/admin-request";
import { canViewMapSyncAdmin } from "@/lib/map-sync-access";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";
import {
  MapSyncClient,
  type MapSyncAccessRequestRow,
  type MapSyncAuditLogRow,
  type MapSyncKeyRow,
} from "./map-sync-client";

export const dynamic = "force-dynamic";

async function loadMapSyncData() {
  const supabase = createAdminClient() as unknown as UntypedSupabase;

  const [requestsResult, keysResult, auditResult] = await Promise.all([
    supabase
      .from("map_sync_access_requests")
      .select("id, property_name, property_id, feature_key, requester_display_name, device_id, status, rejection_reason, created_at, approved_at, rejected_at")
      .in("status", ["pending", "approved"])
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("map_sync_keys")
      .select("id, property_name, property_id, feature_key, requester_display_name, device_id, last_used_at, created_at")
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("map_annotation_audit_logs")
      .select("id, property_id, feature_key, action, annotation_id, actor_display_name, admin_display_name, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  if (requestsResult.error) throw requestsResult.error;
  if (keysResult.error) throw keysResult.error;
  if (auditResult.error) throw auditResult.error;

  return {
    requests: (requestsResult.data ?? []) as MapSyncAccessRequestRow[],
    keys: (keysResult.data ?? []) as MapSyncKeyRow[],
    audits: (auditResult.data ?? []) as MapSyncAuditLogRow[],
  };
}

export default async function AdminMapSyncPage() {
  const admin = await getAdminFromSessionCookie();

  if (!admin) {
    redirect("/admin/login");
  }

  if (!canViewMapSyncAdmin(admin)) {
    return (
      <div className="admin-page">
        <div className="admin-page-header">
          <div>
            <p className="admin-kicker">Property Map</p>
            <h1 className="mt-1 text-2xl font-bold text-primary">Map Data</h1>
            <p className="mt-1 text-sm text-primary/55">
              Shared annotation sync access is managed by property and security administrators.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          Your admin role does not allow map data management.
        </div>
      </div>
    );
  }

  let requests: MapSyncAccessRequestRow[] = [];
  let keys: MapSyncKeyRow[] = [];
  let audits: MapSyncAuditLogRow[] = [];
  let initialError = "";

  try {
    const data = await loadMapSyncData();
    requests = data.requests;
    keys = data.keys;
    audits = data.audits;
  } catch (error) {
    console.error("[admin/map-sync page] Failed to load map data:", error);
    initialError = "Failed to load map data";
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Property Map</p>
          <h1 className="mt-1 text-2xl font-bold text-primary">Map Data</h1>
          <p className="mt-1 text-sm text-primary/55">
            Approve property map annotation access, revoke active map data keys, and review recent
            annotation audit activity.
          </p>
        </div>
      </div>

      <MapSyncClient
        initialRequests={requests}
        initialKeys={keys}
        initialAudits={audits}
        initialError={initialError}
      />
    </div>
  );
}
