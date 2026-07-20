
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildResidentSessionActionUpdate,
  deriveAdminAlerts,
  getResidentAccessHealth,
  summarizeResidentAccessHealth,
  getScannerDeviceHealth,
} = require("../lib/admin-operations");
const {
  buildAdminAuditLogInsert,
} = require("../lib/admin-audit");
const {
  formatAdminAuditAction,
  formatAdminAuditTarget,
} = require("../lib/admin-audit-logs");

test("getResidentAccessHealth separates allowed, stale, denied, and never verified residents", () => {
  const now = Date.parse("2026-06-23T12:00:00.000Z");

  assert.deepEqual(
    getResidentAccessHealth({
      access_allowed: true,
      access_status: "Current",
      last_resman_verified_at: "2026-06-23T11:55:00.000Z",
    }, now, 20 * 60 * 1000),
    {
      status: "verified",
      label: "Verified",
      detail: "ResMan access verified 5 minutes ago.",
      severity: "ok",
      reason: "fresh",
      nextAction: "No action needed.",
    }
  );

  assert.equal(
    getResidentAccessHealth({
      access_allowed: true,
      access_status: "Current",
      last_resman_verified_at: "2026-06-23T11:00:00.000Z",
    }, now, 20 * 60 * 1000).status,
    "stale"
  );

  assert.equal(
    getResidentAccessHealth({
      access_allowed: false,
      access_status: "Former",
      last_resman_verified_at: "2026-06-23T11:55:00.000Z",
    }, now, 20 * 60 * 1000).status,
    "denied"
  );

  assert.equal(
    getResidentAccessHealth({
      access_allowed: true,
      access_status: null,
      last_resman_verified_at: null,
    }, now, 20 * 60 * 1000).status,
    "never_verified"
  );
});

test("getScannerDeviceHealth classifies disabled, never seen, online, and offline scanners", () => {
  const now = Date.parse("2026-06-23T12:00:00.000Z");

  assert.equal(getScannerDeviceHealth({ enabled: false, last_seen_at: null }, now).status, "disabled");
  assert.equal(getScannerDeviceHealth({ enabled: true, last_seen_at: null }, now).status, "never_seen");
  assert.equal(
    getScannerDeviceHealth({ enabled: true, last_seen_at: "2026-06-23T11:58:00.000Z" }, now).status,
    "online"
  );
  assert.equal(
    getScannerDeviceHealth({ enabled: true, last_seen_at: "2026-06-23T10:00:00.000Z" }, now).status,
    "offline"
  );
});

test("deriveAdminAlerts creates actionable alerts without exposing session material", () => {
  const now = Date.parse("2026-06-23T12:00:00.000Z");
  const alerts = deriveAdminAlerts({
    residents: [
      {
        id: "resident-stale",
        name: "Stale Resident",
        unit_id: "101",
        access_allowed: true,
        access_status: "Current",
        last_resman_verified_at: "2026-06-23T10:00:00.000Z",
      },
      {
        id: "resident-denied",
        name: "Denied Resident",
        unit_id: "102",
        access_allowed: false,
        access_status: "Former",
        last_resman_verified_at: "2026-06-23T11:59:00.000Z",
      },
    ],
    scanners: [
      {
        scanner_id: "gate-a",
        name: "Gate A",
        location: "Front gate",
        enabled: true,
        last_seen_at: "2026-06-23T10:00:00.000Z",
      },
    ],
    now,
    residentMaxAgeMs: 20 * 60 * 1000,
    scannerOfflineMs: 30 * 60 * 1000,
  });

  assert.deepEqual(
    alerts.map((alert) => [alert.type, alert.severity, alert.subjectId]),
    [
      ["resident_access_stale", "warning", "resident-stale"],
      ["resident_access_denied", "critical", "resident-denied"],
      ["scanner_offline", "warning", "gate-a"],
    ]
  );
  assert.equal(JSON.stringify(alerts).includes("PortalAuthorizationCookie"), false);
});

test("summarizeResidentAccessHealth counts verification reasons for admin status", () => {
  const now = Date.parse("2026-06-23T12:00:00.000Z");

  assert.deepEqual(
    summarizeResidentAccessHealth(
      [
        { access_allowed: true, access_status: "Current", last_resman_verified_at: "2026-06-23T11:59:00.000Z" },
        { access_allowed: true, access_status: "Current", last_resman_verified_at: "2026-06-23T11:00:00.000Z" },
        { access_allowed: false, access_status: "Former", last_resman_verified_at: "2026-06-23T11:59:00.000Z" },
        { access_allowed: false, access_status: null, last_resman_verified_at: null },
      ],
      now,
      20 * 60 * 1000
    ),
    {
      verified: 1,
      stale: 1,
      denied: 1,
      neverVerified: 1,
      needsVerification: 3,
    }
  );
});

test("buildResidentSessionActionUpdate returns safe patches for admin session actions", () => {
  assert.deepEqual(buildResidentSessionActionUpdate("require_reauth"), {
    access_allowed: false,
    access_status: "Admin reauthentication required",
    last_resman_verified_at: null,
  });

  assert.deepEqual(buildResidentSessionActionUpdate("suspend_access"), {
    access_allowed: false,
    access_status: "Admin suspended",
    last_resman_verified_at: null,
  });
});

test("buildAdminAuditLogInsert records actor, action, target, and metadata", () => {
  assert.deepEqual(
    buildAdminAuditLogInsert(
      { adminId: "admin-1", role: "security_manager", displayName: "Gate Lead" },
      {
        action: "scanner.rotate_secret",
        targetType: "scanner",
        targetId: "gate_a",
        metadata: { location: "Front gate" },
      },
      "2026-06-24T12:00:00.000Z"
    ),
    {
      admin_user_id: "admin-1",
      admin_role: "security_manager",
      admin_display_name: "Gate Lead",
      action: "scanner.rotate_secret",
      target_type: "scanner",
      target_id: "gate_a",
      metadata: { location: "Front gate" },
      created_at: "2026-06-24T12:00:00.000Z",
    }
  );
});

test("admin audit log display helpers produce readable labels", () => {
  assert.equal(formatAdminAuditAction("resident.require_reauth"), "Require resident reauth");
  assert.equal(formatAdminAuditAction("scanner.rotate_secret"), "Rotate scanner secret");
  assert.equal(formatAdminAuditAction("unknown.action_name"), "Unknown action name");

  assert.equal(formatAdminAuditTarget("guest_pass", "pass-123"), "Guest pass pass-123");
  assert.equal(formatAdminAuditTarget("scanner", "gate_a"), "Scanner gate_a");
});
