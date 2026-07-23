import { Fragment } from "react";
import { format, isToday, isYesterday } from "date-fns";
import Link from "next/link";
import {
  formatAdminAuditAction,
  listAdminAuditLogs,
  type AdminAuditLog,
} from "@/lib/admin-audit-logs";
import { AdminIcon } from "../../_components/admin-ui";

export const dynamic = "force-dynamic";

type AuditKind = "danger" | "warn" | "ok" | "info";
type IconName = Parameters<typeof AdminIcon>[0]["name"];

const KIND_PILL: Record<AuditKind, string> = {
  danger: "pill-crit",
  warn: "pill-warn",
  ok: "pill-ok",
  info: "pill-info",
};

function auditVisual(action: string): { kind: AuditKind; icon: IconName } {
  switch (action) {
    case "resident.ban_guest_pass":
    case "resident.suspend_access":
      return { kind: "danger", icon: "ban" };
    case "resident.unban_guest_pass":
      return { kind: "ok", icon: "unlock" };
    case "resident.require_reauth":
      return { kind: "warn", icon: "refresh" };
    case "scanner.create":
      return { kind: "ok", icon: "plus" };
    case "scanner.rotate_secret":
      return { kind: "warn", icon: "rotate" };
    case "scanner.update":
      return { kind: "info", icon: "shield" };
    case "guest_pass.update":
      return { kind: "warn", icon: "x" };
    case "access.approve":
      return { kind: "ok", icon: "check" };
    case "access.reject":
    case "access.revoke":
    case "annotation.delete":
      return { kind: "danger", icon: "x" };
    default:
      return { kind: "info", icon: "shield" };
  }
}

function auditMetadata(log: AdminAuditLog): Record<string, unknown> {
  const { metadata } = log;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function actorLabel(log: AdminAuditLog): string {
  return log.admin_display_name || log.admin_user_id;
}

function targetHref(log: AdminAuditLog): string | null {
  if (log.target_type === "resident") return `/admin/residents/${log.target_id}`;
  if (log.target_type === "scanner") return "/admin/scanners";
  if (log.target_type === "guest_pass") return "/admin/guest-passes";
  if (log.target_type === "resman_unit") return `/admin/units/${log.target_id}`;
  return null;
}

function targetName(log: AdminAuditLog): string {
  const meta = auditMetadata(log);
  const name = meta.residentName ?? meta.scannerName ?? meta.name;
  if (typeof name === "string" && name.trim()) return name;
  if (log.target_type === "scanner") return `scanner ${log.target_id}`;
  if (log.target_type === "resident") return "a resident";
  if (log.target_type === "guest_pass") return "a guest pass";
  if (log.target_type === "resman_unit") {
    const unitNumber = auditMetadata(log).unitNumber;
    return typeof unitNumber === "string" && unitNumber.trim() ? `unit ${unitNumber}` : "a unit";
  }
  return log.target_id;
}

/** Text placed before and after the (linked) target inside the sentence. */
function phrase(action: string): { before: string; after: string } {
  switch (action) {
    case "resident.ban_guest_pass":
      return { before: "blocked guest passes for", after: "" };
    case "resident.unban_guest_pass":
      return { before: "re-enabled guest passes for", after: "" };
    case "unit.ban_guest_pass":
      return { before: "suspended guest visits for", after: "" };
    case "unit.unban_guest_pass":
      return { before: "re-enabled guest visits for", after: "" };
    case "resident.suspend_access":
      return { before: "suspended all access for", after: "" };
    case "resident.require_reauth":
      return { before: "asked", after: "to sign in again" };
    case "scanner.create":
      return { before: "registered", after: "" };
    case "scanner.update":
      return { before: "updated", after: "" };
    case "scanner.rotate_secret":
      return { before: "rotated the device secret for", after: "" };
    case "guest_pass.update":
      return { before: "updated a guest pass for", after: "" };
    case "access.approve":
      return { before: "approved map data access for", after: "" };
    case "access.reject":
      return { before: "rejected a map data access request for", after: "" };
    case "access.revoke":
      return { before: "revoked map data access for", after: "" };
    default:
      return { before: `${formatAdminAuditAction(action).toLowerCase()} —`, after: "" };
  }
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (isToday(date)) return `Today · ${format(date, "MMMM d, yyyy")}`;
  if (isYesterday(date)) return `Yesterday · ${format(date, "MMMM d, yyyy")}`;
  return format(date, "MMMM d, yyyy");
}

export default async function AdminAuditPage() {
  let logs: AdminAuditLog[] = [];
  let initialError = "";

  try {
    logs = await listAdminAuditLogs();
  } catch (error) {
    console.error("[admin/audit page] Failed to load audit logs:", error);
    initialError = "Failed to load audit log";
  }

  let lastDay = "";

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Accountability</p>
          <h1 className="mt-1 text-2xl font-bold text-primary">Audit Log</h1>
          <p className="mt-1 text-sm text-primary/55">
            A plain-language history of every change — who did what, and when.
          </p>
        </div>
      </div>

      <div className="card overflow-hidden">
        {initialError ? (
          <div className="border-b border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {initialError}
          </div>
        ) : null}

        {logs.length === 0 ? (
          <div className="empty-state-cell">No audit entries yet</div>
        ) : (
          <div className="pb-2">
            {logs.map((log) => {
              const day = dayLabel(log.created_at);
              const showHeader = day !== lastDay;
              lastDay = day;

              const visual = auditVisual(log.action);
              const { before, after } = phrase(log.action);
              const href = targetHref(log);
              const name = targetName(log);
              const meta = auditMetadata(log);
              const reason = typeof meta.reason === "string" ? meta.reason.trim() : "";

              return (
                <Fragment key={log.id}>
                  {showHeader ? (
                    <p className="border-b border-primary/[0.06] px-4 pb-2 pt-4 text-[11px] font-bold uppercase tracking-[0.06em] text-primary/40">
                      {day}
                    </p>
                  ) : null}
                  <div className="flex gap-3.5 px-4 py-3 transition-colors hover:bg-primary/[0.03]">
                    <span
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${KIND_PILL[visual.kind]}`}
                    >
                      <AdminIcon name={visual.icon} className="h-[18px] w-[18px]" />
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <p className="text-sm leading-snug text-primary/90">
                        <span className="font-semibold text-primary">{actorLabel(log)}</span>{" "}
                        {before}{" "}
                        {href ? (
                          <Link
                            href={href}
                            className="font-medium text-primary underline-offset-2 hover:underline"
                          >
                            {name}
                          </Link>
                        ) : (
                          <span className="font-medium text-primary">{name}</span>
                        )}
                        {after ? ` ${after}` : ""}
                        {reason ? (
                          <span className="italic text-primary/60"> — &ldquo;{reason}&rdquo;</span>
                        ) : null}
                      </p>
                      <div className="mt-1 flex items-center gap-2 text-[11.5px] text-primary/45">
                        <span className="tabular-nums">{format(new Date(log.created_at), "h:mm a")}</span>
                        <span className="h-[3px] w-[3px] rounded-full bg-primary/30" />
                        <span className="font-mono text-[10.5px] text-primary/35">{log.action}</span>
                      </div>
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
