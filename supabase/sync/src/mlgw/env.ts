/**
 * MLGW environment, logging, timeouts, and transient-error detection.
 *
 * Ports:
 *   - MLGWScriptEnvironment.swift -> SSO URLs, `debugLog`/`debugStage`,
 *     `env`, `configuredHTTPTimeout`, the redaction regexes, and the
 *     `XMS_MLGW_DEBUG_LOGS` gate.
 *   - MLGWNetworkRetry.swift      -> `readableErrorDescription`,
 *     `errorDescriptionLooksTransient` (transient-error detection; brief §9).
 *
 * Logging is gated on `XMS_MLGW_DEBUG_LOGS` and routed through guarded
 * `console.debug`. Unlike the Swift `#if DEBUG` default, TS defaults OFF unless
 * the env var is explicitly truthy. `configuredHTTPTimeout` returns
 * **milliseconds** (brief) — env values are read in seconds, matching the Swift
 * `TimeInterval` semantics, and converted.
 */

// MARK: - SSO endpoints (MLGWScriptEnvironment.swift)

/** SAML IdP SSOService entry point for the myMLGW SP (RelayState -> mymlgw root). */
export const myMLGWSsoLoginURL =
  "https://ssomlgw.mlgw.org/sso/saml2/idp/SSOService.php?spentityid=https%3A%2F%2Fmymlgw.mlgw.org%2Fsaml&RelayState=https%3A%2F%2Fmymlgw.mlgw.org%2F";

/** simpleSAMLphp session endpoint (used to read/refresh the SSO session). */
export const myMLGWSsoSessionURL = "https://ssomlgw.mlgw.org/sso/session.php";

/** SAML SSOService entry point for the FIS Global bill-pay SP. */
export const billPaySsoURL =
  "https://ssomlgw.mlgw.org/sso/saml2/idp/SSOService.php/?spentityid=https://ih-prd.fisglobal.com/sso/SSOServlet";

// MARK: - Environment access

/** Read a trimmed, non-empty env var, or a default. Port of Swift `env(_:default:)`. */
export function env(name: string, defaultValue?: string): string | undefined {
  const value = process.env[name];
  if (value !== undefined && value.trim().length > 0) {
    return value;
  }
  return defaultValue;
}

/**
 * Resolve an HTTP timeout in **milliseconds**. The env var is interpreted in
 * seconds (as the Swift `TimeInterval` was), so a positive numeric value is
 * multiplied by 1000; otherwise `defaultMs` is returned unchanged. Port of Swift
 * `configuredHTTPTimeout(_:default:)`, adapted to ms.
 */
export function configuredHTTPTimeout(name: string, defaultMs: number): number {
  const raw = env(name);
  if (raw === undefined) return defaultMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return defaultMs;
  return seconds * 1000;
}

/**
 * Resolve a positive integer concurrency limit from `name`, falling back to
 * `defaultValue`. Used for the shared request scheduler's ceiling (e.g.
 * `MLGW_CONNECTIONS_PER_HOST`).
 */
export function configuredConcurrency(name: string, defaultValue: number): number {
  const raw = env(name);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return defaultValue;
  return value;
}

// MARK: - Debug logging + redaction (MLGWScriptEnvironment.swift)

/** `XMS_MLGW_DEBUG_LOGS` in {1,true,yes,on} (case-insensitive, trimmed). */
export function isMLGWDebugLoggingEnabled(): boolean {
  const raw = process.env["XMS_MLGW_DEBUG_LOGS"]?.trim().toLowerCase();
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw);
}

/**
 * Redact secrets and PII from a log line before it is emitted. Same five
 * case-insensitive `key=value` patterns as the Swift `redactedMLGWLogMessage`:
 * sessionHandle, SAMLResponse, password, accountNumber, documentId.
 */
export function redactedMLGWLogMessage(message: string): string {
  return message
    .replace(/(sessionHandle=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(SAMLResponse=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(password=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(accountNumber=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(documentId=)[^&\s]+/gi, "$1<redacted>");
}

/** Emit a redacted debug line when `XMS_MLGW_DEBUG_LOGS` is enabled. */
export function debugLog(message: string): void {
  if (!isMLGWDebugLoggingEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(redactedMLGWLogMessage(message));
}

/** Log a `[Stage]` marker with optional metadata. Port of `debugStage`. */
export function debugStage(stage: string, metadata = ""): void {
  const suffix = metadata.length === 0 ? "" : ` | ${metadata}`;
  debugLog(`[Stage] ${stage}${suffix}`);
}

/** `[Profile]`-prefixed debug line. Port of `profileLog`. */
export function profileLog(message: string): void {
  debugLog(`[Profile] ${message}`);
}

/** Format a millisecond duration as `"%.1fs"` seconds. Port of `formattedDuration`. */
export function formattedDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** Format a throughput rate as `"<n>/s"`. Port of `formattedProfileRate`. */
export function formattedProfileRate(count: number, ms: number): string {
  if (ms <= 0 || count <= 0) return "0/s";
  const seconds = ms / 1000;
  return `${(count / seconds).toFixed(1)}/s`;
}

// MARK: - Transient-error detection (MLGWNetworkRetry.swift)

const GENERIC_ERROR_MESSAGES = [
  "The operation couldn’t be completed.",
  "The operation couldn't be completed.",
];

/**
 * Best human-readable description of an error, skipping the generic Cocoa
 * "operation couldn't be completed" strings in favor of a more specific one.
 * Port of Swift `readableErrorDescription`.
 */
export function readableErrorDescription(error: unknown): string {
  const localized = (error instanceof Error ? error.message : String(error)).trim();
  if (localized.length > 0 && !GENERIC_ERROR_MESSAGES.includes(localized)) {
    return localized;
  }
  const described = String(error).trim();
  return described.length === 0 ? localized : described;
}

const TRANSIENT_NEEDLES = [
  "timed out",
  "timeout",
  "network connection was lost",
  "cannot connect to host",
  "could not connect",
  "cannot find host",
  "dns lookup failed",
  "not connected to internet",
  "http 500",
  "http 502",
  "http 503",
  "http 504",
];

/**
 * Heuristic: does the error text look like a retryable network blip? Port of
 * Swift `errorDescriptionLooksTransient` (same needle list, lowercased match).
 */
export function errorDescriptionLooksTransient(error: unknown): boolean {
  const text = readableErrorDescription(error).toLowerCase();
  return TRANSIENT_NEEDLES.some((needle) => text.includes(needle));
}
