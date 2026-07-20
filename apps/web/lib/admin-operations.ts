import { residentAccessFreshnessMs } from "./residents";

export type HealthSeverity = "ok" | "warning" | "critical" | "muted";

export type ResidentAccessHealthStatus = "verified" | "stale" | "denied" | "never_verified";

export type ResidentAccessHealth = {
  status: ResidentAccessHealthStatus;
  label: string;
  detail: string;
  severity: HealthSeverity;
  reason: string;
  nextAction: string;
};

export type ScannerDeviceHealthStatus = "online" | "offline" | "disabled" | "never_seen";

export type ScannerDeviceHealth = {
  status: ScannerDeviceHealthStatus;
  label: string;
  detail: string;
  severity: HealthSeverity;
};

export type AdminAlertType =
  | "resident_access_stale"
  | "resident_access_denied"
  | "scanner_offline";

export type AdminAlert = {
  type: AdminAlertType;
  severity: Exclude<HealthSeverity, "ok" | "muted">;
  subjectId: string;
  title: string;
  detail: string;
  metadata: Record<string, string | number | boolean | null>;
};

type ResidentAccessInput = {
  id?: string;
  name?: string | null;
  unit_id?: string | null;
  access_allowed?: boolean | null;
  access_status?: string | null;
  last_resman_verified_at?: string | null;
};

type ScannerDeviceInput = {
  scanner_id?: string | null;
  name?: string | null;
  location?: string | null;
  enabled?: boolean | null;
  last_seen_at?: string | null;
};

function minutesAgo(timestamp: string, now: number): number | null {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((now - parsed) / 60_000));
}

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "at an unknown time";
  if (minutes < 1) return "less than a minute ago";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

export function getResidentAccessHealth(
  resident: ResidentAccessInput,
  now = Date.now(),
  maxAgeMs = residentAccessFreshnessMs()
): ResidentAccessHealth {
  if (!resident.last_resman_verified_at) {
    return {
      status: "never_verified",
      label: "Needs verification",
      detail: "No ResMan heartbeat has been recorded for this resident.",
      severity: "warning",
      reason: "never_verified",
      nextAction: "Resident must open the app and complete a ResMan heartbeat or sign in again.",
    };
  }

  const verifiedAt = Date.parse(resident.last_resman_verified_at);
  const ageText = formatMinutes(minutesAgo(resident.last_resman_verified_at, now));

  if (!resident.access_allowed) {
    return {
      status: "denied",
      label: "Access denied",
      detail: `Latest ResMan status is ${resident.access_status ?? "not allowed"}; verified ${ageText}.`,
      severity: "critical",
      reason: "resman_denied",
      nextAction: "Resident must resolve their ResMan status before using Emberly access.",
    };
  }

  if (!Number.isFinite(verifiedAt) || now - verifiedAt > maxAgeMs) {
    return {
      status: "stale",
      label: "Heartbeat stale",
      detail: `ResMan access was last verified ${ageText}.`,
      severity: "warning",
      reason: "heartbeat_stale",
      nextAction: "Resident should open the app to refresh access or sign in again.",
    };
  }

  return {
    status: "verified",
    label: "Verified",
    detail: `ResMan access verified ${ageText}.`,
    severity: "ok",
    reason: "fresh",
    nextAction: "No action needed.",
  };
}

export function summarizeResidentAccessHealth(
  residents: ResidentAccessInput[],
  now = Date.now(),
  maxAgeMs = residentAccessFreshnessMs()
): {
  verified: number;
  stale: number;
  denied: number;
  neverVerified: number;
  needsVerification: number;
} {
  const summary = {
    verified: 0,
    stale: 0,
    denied: 0,
    neverVerified: 0,
    needsVerification: 0,
  };

  for (const resident of residents) {
    const health = getResidentAccessHealth(resident, now, maxAgeMs);
    if (health.status === "verified") summary.verified += 1;
    if (health.status === "stale") summary.stale += 1;
    if (health.status === "denied") summary.denied += 1;
    if (health.status === "never_verified") summary.neverVerified += 1;
  }

  summary.needsVerification = summary.stale + summary.denied + summary.neverVerified;
  return summary;
}

export function getScannerDeviceHealth(
  scanner: ScannerDeviceInput,
  now = Date.now(),
  offlineAfterMs = 30 * 60 * 1000
): ScannerDeviceHealth {
  if (scanner.enabled === false) {
    return {
      status: "disabled",
      label: "Disabled",
      detail: "This scanner is disabled and cannot verify entry.",
      severity: "muted",
    };
  }

  if (!scanner.last_seen_at) {
    return {
      status: "never_seen",
      label: "Never seen",
      detail: "No verification request has been recorded for this scanner.",
      severity: "warning",
    };
  }

  const lastSeenAt = Date.parse(scanner.last_seen_at);
  const ageText = formatMinutes(minutesAgo(scanner.last_seen_at, now));

  if (!Number.isFinite(lastSeenAt) || now - lastSeenAt > offlineAfterMs) {
    return {
      status: "offline",
      label: "Offline",
      detail: `Last seen ${ageText}.`,
      severity: "warning",
    };
  }

  return {
    status: "online",
    label: "Online",
    detail: `Last seen ${ageText}.`,
    severity: "ok",
  };
}

export function deriveAdminAlerts(input: {
  residents: ResidentAccessInput[];
  scanners: ScannerDeviceInput[];
  now?: number;
  residentMaxAgeMs?: number;
  scannerOfflineMs?: number;
}): AdminAlert[] {
  const now = input.now ?? Date.now();
  const alerts: AdminAlert[] = [];

  for (const resident of input.residents) {
    if (!resident.id) continue;
    const health = getResidentAccessHealth(resident, now, input.residentMaxAgeMs);
    if (health.status === "stale") {
      alerts.push({
        type: "resident_access_stale",
        severity: "warning",
        subjectId: resident.id,
        title: `${resident.name ?? "Resident"} needs a heartbeat`,
        detail: health.detail,
        metadata: {
          residentId: resident.id,
          unit: resident.unit_id ?? null,
          accessStatus: resident.access_status ?? null,
        },
      });
    }
    if (health.status === "denied") {
      alerts.push({
        type: "resident_access_denied",
        severity: "critical",
        subjectId: resident.id,
        title: `${resident.name ?? "Resident"} is not currently allowed`,
        detail: health.detail,
        metadata: {
          residentId: resident.id,
          unit: resident.unit_id ?? null,
          accessStatus: resident.access_status ?? null,
        },
      });
    }
  }

  for (const scanner of input.scanners) {
    if (!scanner.scanner_id) continue;
    const health = getScannerDeviceHealth(scanner, now, input.scannerOfflineMs);
    if (health.status === "offline") {
      alerts.push({
        type: "scanner_offline",
        severity: "warning",
        subjectId: scanner.scanner_id,
        title: `${scanner.name ?? scanner.scanner_id} is offline`,
        detail: health.detail,
        metadata: {
          scannerId: scanner.scanner_id,
          location: scanner.location ?? null,
        },
      });
    }
  }

  return alerts;
}

export function buildResidentSessionActionUpdate(
  action: "require_reauth" | "suspend_access"
): {
  access_allowed: false;
  access_status: string;
  last_resman_verified_at: null;
} {
  if (action === "suspend_access") {
    return {
      access_allowed: false,
      access_status: "Admin suspended",
      last_resman_verified_at: null,
    };
  }

  return {
    access_allowed: false,
    access_status: "Admin reauthentication required",
    last_resman_verified_at: null,
  };
}
