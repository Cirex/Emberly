"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AdminAlert } from "@/lib/admin-alerts";
import { AdminIcon } from "../../_components/admin-ui";

type NavIcon = "chart" | "users" | "ticket" | "log" | "scanner" | "audit" | "map" | "building" | "wrench" | "bolt";

const navGroups: Array<{
  label: string;
  items: Array<{ href: string; label: string; icon: NavIcon; superAdminOnly?: boolean }>;
}> = [
  {
    label: "Overview",
    items: [{ href: "/admin", label: "Dashboard", icon: "chart" }],
  },
  {
    label: "People & Access",
    items: [
      { href: "/admin/residents", label: "Resident Access", icon: "users" },
      { href: "/admin/guest-passes", label: "Guest Passes", icon: "ticket" },
    ],
  },
  {
    label: "Security",
    items: [
      { href: "/admin/entry-logs", label: "Entry Logs", icon: "log" },
      { href: "/admin/scanners", label: "Scanners", icon: "scanner" },
    ],
  },
  {
    label: "Property Management",
    items: [
      { href: "/admin/units", label: "Units", icon: "building" },
      { href: "/admin/work-orders", label: "Work Orders", icon: "wrench" },
      { href: "/admin/pm", label: "Preventive", icon: "wrench" },
      { href: "/admin/utilities", label: "Utilities", icon: "bolt" },
      { href: "/admin/property-map", label: "Property Map", icon: "map" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/admin/audit", label: "Audit Log", icon: "audit" },
      { href: "/admin/mcp-tokens", label: "Access Tokens", icon: "audit" },
      { href: "/admin/users", label: "Admin Users", icon: "users", superAdminOnly: true },
    ],
  },
];

const allItems = navGroups.flatMap((g) => g.items);

function Icon({ icon }: { icon: NavIcon }) {
  const c = "h-[17px] w-[17px]";
  const p = (d: string) => (
    <svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
  switch (icon) {
    case "chart":
      return p("M3 13h8V3H3zM13 21h8V3h-8zM3 21h8v-6H3z");
    case "users":
      return (
        <svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
        </svg>
      );
    case "ticket":
      return p("M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v.5a2 2 0 0 0 0 5V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-.5a2 2 0 0 0 0-5z");
    case "log":
      return (
        <svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M9 13l2 2 4-4" />
        </svg>
      );
    case "scanner":
      return (
        <svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M8 8h8M8 12h8M8 16h4" />
        </svg>
      );
    case "audit":
      return (
        <svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    case "map":
      return (
        <svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" />
          <path d="M9 3v15M15 6v15" />
        </svg>
      );
    case "building":
      return (
        <svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 21h18M6 21V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16M14 9h3a1 1 0 0 1 1 1v11" />
          <path d="M9 8h1M9 12h1M9 16h1" />
        </svg>
      );
    case "wrench":
      return p(
        "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
      );
    case "bolt":
      return p("M13 2 3 14h9l-1 8 10-12h-9l1-8z");
  }
}

function isActivePath(pathname: string, href: string) {
  if (href === "/admin") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function breadcrumbLabel(pathname: string) {
  if (pathname === "/admin") return "Dashboard";
  if (pathname.startsWith("/admin/leases/")) return "Lease Detail";
  if (pathname.startsWith("/admin/units/") && pathname !== "/admin/units") return "Unit Detail";
  const match = allItems
    .filter((i) => i.href !== "/admin")
    .find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  if (!match) return "Admin";
  if (pathname.startsWith("/admin/residents/") && pathname !== "/admin/residents") {
    return "Resident Detail";
  }
  return match.label;
}

function severityPill(sev?: string) {
  if (sev === "critical") return "pill-crit";
  if (sev === "warning") return "pill-warn";
  return "pill-neutral";
}

function NotificationBell() {
  const [alerts, setAlerts] = useState<AdminAlert[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/alerts?status=open")
      .then((r) => (r.ok ? r.json() : { alerts: [] }))
      .then((d) => {
        if (active) setAlerts(Array.isArray(d.alerts) ? d.alerts : []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const count = alerts.length;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={count > 0 ? `${count} open alerts` : "Alerts"}
        className={`relative inline-flex h-10 w-10 items-center justify-center rounded-lg border bg-white shadow-xs transition-colors ${
          count > 0
            ? "border-red-300 text-red-600 hover:border-red-400"
            : "border-primary/15 text-primary/70 hover:border-accent/70 hover:text-primary"
        }`}
      >
        {count > 0 ? (
          <span className="absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-cream bg-red-600 px-1 text-[11px] font-bold leading-none text-white">
            {count}
          </span>
        ) : null}
        <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+10px)] z-50 w-[344px] overflow-hidden rounded-xl border border-line bg-white shadow-2xl shadow-primary/20"
        >
          <div className="flex items-center justify-between border-b border-primary/10 px-4 py-3">
            <b className="text-sm font-bold text-primary">Alerts</b>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${count > 0 ? "bg-red-50 text-red-600" : "bg-primary/5 text-primary/50"}`}>
              {count} open
            </span>
          </div>
          <div className="max-h-[340px] overflow-y-auto p-1.5">
            {count === 0 ? (
              <div className="px-4 py-7 text-center text-sm text-primary/45">No open alerts. All clear.</div>
            ) : (
              alerts.slice(0, 6).map((a) => (
                <Link
                  key={a.id}
                  href="/admin/alerts"
                  onClick={() => setOpen(false)}
                  className="flex gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-primary/5"
                >
                  <span className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg ${severityPill(a.severity)}`}>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.3 3.8 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z" />
                      <path d="M12 9v4M12 17h.01" />
                    </svg>
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium leading-snug text-primary">{a.title}</span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-primary/45">{a.detail}</span>
                  </span>
                </Link>
              ))
            )}
          </div>
          <Link
            href="/admin/alerts"
            onClick={() => setOpen(false)}
            className="flex items-center justify-center gap-1.5 border-t border-primary/10 bg-primary/[0.03] py-3 text-xs font-semibold text-primary transition-colors hover:bg-primary/[0.06]"
          >
            View all alerts
            <AdminIcon name="chevron-right" className="h-3.5 w-3.5" />
          </Link>
        </div>
      ) : null}
    </div>
  );
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  security_manager: "Security Manager",
  property_manager: "Property Manager",
  viewer: "Viewer",
};

function roleLabel(role: string | undefined): string {
  return ROLE_LABELS[role ?? ""] ?? (role ?? "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function initialsOf(name: string | undefined): string {
  // Tolerate a missing name: a tab left open across a deploy/HMR can replay a
  // server payload from before this prop existed, and a "?" avatar beats a crash.
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** The signed-in admin, top right: click for account actions. */
function UserMenu({ name, role }: { name: string; role: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative border-l border-line pl-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2.5 rounded-lg py-1 pl-1 pr-2 transition-colors hover:bg-black/[0.04] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-primaryLight to-primary text-[13px] font-bold text-white">
          {initialsOf(name)}
        </span>
        <span className="hidden text-left text-[13px] leading-tight sm:block">
          <b className="block font-semibold text-textNavy">{name}</b>
          <span className="text-[11.5px] text-muted">{roleLabel(role)}</span>
        </span>
        <AdminIcon
          name="chevron-right"
          className={`h-3 w-3 opacity-50 transition-transform ${open ? "-rotate-90" : "rotate-90"}`}
        />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-2 w-52 overflow-hidden rounded-xl border border-line bg-white shadow-lg"
        >
          <div className="border-b border-line px-4 py-3 text-[13px] leading-tight">
            <b className="block font-semibold text-textNavy">{name}</b>
            <span className="text-[11.5px] text-muted">{roleLabel(role)}</span>
          </div>
          <form action="/api/admin/logout" method="POST">
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium text-textNavy transition-colors hover:bg-red-50 hover:text-red-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
            >
              <AdminIcon name="log-out" className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

export function AdminShell({
  children,
  adminName,
  adminRole,
}: {
  children: React.ReactNode;
  adminName: string;
  adminRole: string;
}) {
  const pathname = usePathname();

  // Reset scroll to the top on page navigation. Keyed on pathname (not the full
  // URL), so filter/search query changes on the same page don't jump the view —
  // only real page changes do. Fixes SPA navigations (e.g. list → detail)
  // landing scrolled down so the page's top is off-screen.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className="flex min-h-screen bg-cream">
      {/* Persistent left sidebar — this is a desktop, single-user admin tool, so
          the sidebar is always a fixed left column (no responsive top-nav). */}
      <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-white/10 bg-primary text-cream shadow-lg shadow-primary/10">
        <div className="flex flex-col items-stretch gap-3 border-b border-white/10 px-4 pb-4 pt-5">
          <Link href="/admin" className="flex flex-col items-center gap-3">
            <Image
              src="/logo-reversed.png"
              alt="Emberly Apartments"
              width={300}
              height={196}
              priority
              className="h-auto w-full max-w-[168px] object-contain"
            />
            <span className="block text-center text-[10px] font-bold uppercase tracking-[0.2em] text-cream/45">
              Admin Portal
            </span>
          </Link>
        </div>

        <nav className="flex flex-1 flex-col gap-0 overflow-y-auto px-3 py-3">
          {navGroups.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="block px-2.5 pb-1.5 text-[10.5px] font-bold uppercase tracking-[0.09em] text-cream/40">
                {group.label}
              </p>
              <div className="flex flex-col">
                {group.items
                  .filter((item) => !item.superAdminOnly || adminRole === "super_admin")
                  .map((item) => {
                  const active = isActivePath(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent ${
                        active
                          ? "bg-white font-semibold text-primary shadow-xs"
                          : "text-white/75 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      <Icon icon={item.icon} />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="mt-auto border-t border-white/10 p-3">
          <div className="mb-2 flex items-center gap-2.5 rounded-lg bg-white/[0.06] px-3 py-2.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_0_4px_rgba(52,211,153,0.18)]" />
            <div className="min-w-0 text-xs">
              <p className="font-semibold text-white">All systems normal</p>
              <p className="text-cream/45">API · DB · Scanners</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-4 border-b border-line bg-cream/80 px-5 py-3 backdrop-blur-md sm:px-8">
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted">
            <AdminIcon name="shield" className="h-3.5 w-3.5 opacity-60" />
            Admin
            <AdminIcon name="chevron-right" className="h-3 w-3 opacity-50" />
            <b className="font-semibold text-textNavy">{breadcrumbLabel(pathname)}</b>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <NotificationBell />
            <UserMenu name={adminName} role={adminRole} />
          </div>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
