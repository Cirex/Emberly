"use client";

import { useState } from "react";
import { fetchAdminJson } from "../_components/admin-fetch";

/** Assignable roles, most- to least-privileged. Kept local so this client
 *  component never imports the server-only admin-users module at runtime. */
const ROLES = ["super_admin", "property_manager", "security_manager", "viewer"] as const;
type Role = (typeof ROLES)[number];

export interface AdminUserRow {
  id: string;
  resman_username: string;
  display_name: string | null;
  role: Role;
  active: boolean;
  resman_person_id: string | null;
  last_login_at: string | null;
  created_at: string;
}

interface Props {
  initialUsers: AdminUserRow[];
  currentAdminId: string;
  initialError: string;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function AdminUsersClient({ initialUsers, currentAdminId, initialError }: Props) {
  const [users, setUsers] = useState<AdminUserRow[]>(initialUsers);
  const [drafts, setDrafts] = useState<Record<string, Role>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState("");

  function setDraft(id: string, role: Role) {
    setDrafts((prev) => ({ ...prev, [id]: role }));
  }

  async function refresh() {
    try {
      const res = await fetchAdminJson<{ data: AdminUserRow[] }>("/api/admin/admins");
      setUsers(res.data);
      setDrafts({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh admin users");
    }
  }

  async function save(user: AdminUserRow) {
    const nextRole = drafts[user.id];
    if (!nextRole || nextRole === user.role) return;

    if (user.id === currentAdminId && nextRole !== "super_admin") {
      const ok = window.confirm(
        "You are changing your OWN role away from super_admin. You will lose access to this page immediately. Continue?",
      );
      if (!ok) return;
    }

    setError("");
    setNotice("");
    setSavingId(user.id);
    try {
      const res = await fetchAdminJson<{ data: AdminUserRow }>(`/api/admin/admins/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      setUsers((prev) => prev.map((u) => (u.id === user.id ? res.data : u)));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[user.id];
        return next;
      });
      setNotice(`Updated ${res.data.display_name ?? res.data.resman_username} to ${res.data.role}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update role");
      await refresh();
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">System</p>
          <h1 className="text-2xl font-semibold text-primary">Admin Users</h1>
          <p className="mt-1 text-sm text-muted">
            Staff who have signed into the dashboard. New sign-ins start as <code>viewer</code> — promote them here.
            <code>super_admin</code> has full access; the last active one can&apos;t be demoted.
          </p>
        </div>
      </div>

      {error ? <p className="mb-4 text-sm font-semibold text-red-600">{error}</p> : null}
      {notice ? <p className="mb-4 text-sm font-semibold text-primary">{notice}</p> : null}

      <div className="card overflow-x-auto">
        <table className="admin-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last login</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-sm text-muted">
                  No admin users yet.
                </td>
              </tr>
            ) : (
              users.map((u) => {
                const draft = drafts[u.id] ?? u.role;
                const changed = draft !== u.role;
                const isSelf = u.id === currentAdminId;
                return (
                  <tr key={u.id}>
                    <td className="text-primary">
                      <span className="font-semibold">
                        {u.display_name ?? u.resman_username}
                        {isSelf ? <span className="ml-2 text-xs font-normal text-muted">(you)</span> : null}
                      </span>
                      <span className="block text-xs text-muted">{u.resman_username}</span>
                    </td>
                    <td>
                      <select
                        className="admin-input"
                        value={draft}
                        disabled={savingId === u.id}
                        onChange={(e) => setDraft(u.id, e.target.value as Role)}
                        aria-label={`Role for ${u.display_name ?? u.resman_username}`}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span
                        className={
                          u.active ? "text-sm font-semibold text-primary" : "text-sm font-semibold text-red-600"
                        }
                      >
                        {u.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="tabular-nums text-muted">{formatDate(u.last_login_at)}</td>
                    <td className="tabular-nums text-muted">{formatDate(u.created_at)}</td>
                    <td className="text-right">
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={!changed || savingId === u.id}
                        onClick={() => save(u)}
                      >
                        {savingId === u.id ? "Saving…" : "Save"}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
