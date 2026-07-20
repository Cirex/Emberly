/**
 * Wire-format contract shared between emberly-web (server) and the resident /
 * scanner clients. Changing any value here is a breaking protocol change for
 * already-deployed clients.
 */

/** QR prefix for signed resident entry tokens. */
export const RESIDENT_ENTRY_TOKEN_PREFIX = "emberly://resident/";

/** QR prefix for signed guest entry tokens. */
export const GUEST_ENTRY_TOKEN_PREFIX = "emberly://guest-entry/";

/**
 * `reason` / `reasonCode` emitted by the entry-token and verify-pass routes
 * when the resident's ResMan access heartbeat is stale. The resident app
 * string-matches this value to trigger a heartbeat-and-retry.
 */
export const RESIDENT_ACCESS_STALE_REASON = "resident_access_stale";

/** Header carrying the admin login key. */
export const ADMIN_KEY_HEADER = "x-admin-key";

/** Header carrying the scanner API key. */
export const SCANNER_KEY_HEADER = "x-scanner-key";

/** Cookie holding the signed admin session token. */
export const ADMIN_SESSION_COOKIE = "emberly_admin_session";

export const EMBERLY_PROPERTY_NAME = "Emberly Apartments";

export const PRODUCTION_ORIGIN = "https://emberly.krkn.app";
