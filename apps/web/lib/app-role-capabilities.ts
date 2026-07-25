/**
 * Token authorization POLICY — which role may reach which capability.
 *
 * Deliberately separate from `resman-api-auth.ts`: that module authenticates,
 * which means Supabase, rate limiting and request parsing. This one is pure
 * data plus two total functions, so the policy can be read, reviewed and tested
 * on its own — including by route suites that stub the authentication layer out
 * but still want the real allow/deny decision.
 */
import type { AccessTokenSubject } from "./access-tokens";

/**
 * Native-app tokens (minted via /api/admin/auth/app-token with a SCOPED role)
 * may reach only the capabilities their app actually uses. Back-office roles
 * (staff, super_admin, …) have no entry here and are unrestricted by role —
 * limited only by their explicit `scopes`. This is the read-side complement to
 * the scanner `scannerVisible` allowlist: without it, a leaked maintenance
 * token could pull the financial ledger (`transactions`), the resident roster
 * (`residents`/`leases`), and MLGW billing, none of which the maintenance app
 * has any business reading.
 *
 * Capability names double as resource names for the generic resman resources
 * (`units`, `work-orders`), and use a `manager:` prefix for the bespoke
 * back-office surfaces that have no resource-registry entry.
 */
const APP_ROLE_CAPABILITIES: Record<string, ReadonlySet<string>> = {
  /**
   * EmberlyMaintenance — work orders, units, PM rounds, map annotations.
   * PM rounds ride on `work-orders` on purpose: tokens minted before the
   * manager role existed carry exactly `["units", "work-orders"]`, and gating
   * PM on its own capability would have signed every tech out of that tab.
   */
  security_manager: new Set(["units", "work-orders"]),
  /**
   * EmberlyManager — the back-office read surface plus its action writes.
   * Deliberately not a superset of everything: this is still an app token on a
   * phone, so it reaches the manager screens and nothing else.
   */
  property_manager: new Set([
    "units",
    "work-orders",
    "manager:people",
    "manager:ledger",
    "manager:delinquency",
    "manager:leases",
    "manager:insurance",
    "manager:mlgw",
    "manager:renewals",
    "manager:reports",
    "manager:snapshots",
  ]),
};

/** The scopes an app token is pinned to — mirrors its role's capability set. */
export function appRoleScopes(role: string): string[] {
  return [...(APP_ROLE_CAPABILITIES[role] ?? [])];
}

/**
 * Whether an authenticated token is forbidden from a resource. `resource` is the
 * name matched against the token's `scopes`; `capability` (defaults to
 * `resource`) is matched against the role allowlist, letting a PII-heavy bespoke
 * route (e.g. the guard-only unit detail pane) be denied to field devices while
 * still counting against the `units` scope for back-office tokens.
 */
export function tokenForbiddenForResource(
  subject: AccessTokenSubject,
  resource: string,
  capability: string = resource,
): boolean {
  const roleAllow = APP_ROLE_CAPABILITIES[subject.role];
  if (roleAllow && !roleAllow.has(capability)) return true;
  if (subject.scopes.length > 0 && !subject.scopes.includes(resource)) return true;
  return false;
}
