import type { ReactNode } from "react";

/**
 * Line icons for /admin/utilities, drawn in the admin shell's house style:
 * 24×24 grid, no fill, `currentColor` stroke at width 2, round caps and joins.
 * They inherit color from their container — the emoji they replaced carried
 * their own palette, which fought the Emberly ramp everywhere they appeared.
 */

export type IconName =
  | "invoice"
  | "house"
  | "building"
  | "user"
  | "file"
  | "trend"
  | "bars"
  | "clock"
  | "calendar"
  | "bolt"
  | "droplet"
  | "card"
  | "branch"
  | "badge"
  | "list"
  | "check"
  | "close"
  | "equals"
  | "riseArrow"
  | "rotate"
  | "arrowRight"
  | "exit"
  | "chevronRight"
  | "chevronDown"
  | "exchange"
  | "dollar"
  | "upload";

const PATHS: Record<IconName, ReactNode> = {
  invoice: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </>
  ),
  house: (
    <>
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </>
  ),
  building: (
    <>
      <path d="M3 21h18M6 21V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16M14 9h3a1 1 0 0 1 1 1v11" />
      <path d="M9 8h1M9 12h1M9 16h1" />
    </>
  ),
  user: (
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>
  ),
  trend: (
    <>
      <path d="m23 6-9.5 9.5-5-5L1 18" />
      <path d="M17 6h6v6" />
    </>
  ),
  bars: <path d="M12 20V10M18 20V4M6 20v-4" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  bolt: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  droplet: <path d="M12 2.7 6.3 8.4a8 8 0 1 0 11.4 0z" />,
  card: (
    <>
      <rect x="1" y="4" width="22" height="16" rx="2" />
      <path d="M1 10h22" />
    </>
  ),
  branch: (
    <>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  badge: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <circle cx="8.5" cy="10" r="2" />
      <path d="M5 17a3.5 3.5 0 0 1 7 0M15 9h4M15 13h4" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  equals: <path d="M5 9h14M5 15h14" />,
  riseArrow: (
    <>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </>
  ),
  rotate: (
    <>
      <path d="M21 4v6h-6" />
      <path d="M19.4 15a8 8 0 1 1-1.6-8.6L21 10" />
    </>
  ),
  arrowRight: <path d="M5 12h14M12 5l7 7-7 7" />,
  exit: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </>
  ),
  chevronRight: <path d="m9 18 6-6-6-6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  exchange: (
    <>
      <path d="M4 8h16m-4-4 4 4-4 4" />
      <path d="M20 16H4m4-4-4 4 4 4" />
    </>
  ),
  dollar: <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />,
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5M12 3v13" />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flexShrink: 0 }}
    >
      {PATHS[name]}
    </svg>
  );
}
