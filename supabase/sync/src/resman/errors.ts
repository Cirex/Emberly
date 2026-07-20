/**
 * ResMan scraping error union — port of KrakenCore's `ResManScrapingError`
 * (Services/Scraping/ResManScrapingProvider.swift). Design §3.1.
 *
 * `authenticationRequired` is the one the jobs treat specially: it aborts the
 * whole job (cancel in-flight work, rethrow) rather than retrying, so a stale
 * session never triggers a retry storm (design §5.3).
 */

export type ResManErrorKind =
  | "notImplemented"
  | "authenticationRequired"
  | "parsingFailed"
  | "networkError"
  | "serverOverloaded"
  | "custom";

/**
 * A single Error subclass carrying a discriminated `kind` — the idiomatic TS
 * equivalent of the Swift enum-with-associated-values. `instanceof` +
 * `kind`-switching both work, and it preserves an `errorDescription` matching
 * the Swift `LocalizedError` text for parity in logs.
 */
export class ResManScrapingError extends Error {
  readonly kind: ResManErrorKind;
  /** Present when `kind === "networkError"` — the underlying cause. */
  readonly cause?: unknown;

  private constructor(kind: ResManErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "ResManScrapingError";
    this.kind = kind;
    this.cause = cause;
    // Restore the prototype chain (TS target below ES2015 / transpilers).
    Object.setPrototypeOf(this, ResManScrapingError.prototype);
  }

  static notImplemented(): ResManScrapingError {
    return new ResManScrapingError("notImplemented", "Resman scraping is not yet implemented");
  }

  static authenticationRequired(): ResManScrapingError {
    return new ResManScrapingError(
      "authenticationRequired",
      "Authentication required to access Resman",
    );
  }

  static parsingFailed(detail: string): ResManScrapingError {
    return new ResManScrapingError("parsingFailed", `Failed to parse Resman data: ${detail}`);
  }

  static networkError(cause: unknown): ResManScrapingError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new ResManScrapingError("networkError", `Network error: ${detail}`, cause);
  }

  static serverOverloaded(path: string): ResManScrapingError {
    return new ResManScrapingError("serverOverloaded", `ResMan server overloaded for ${path}`);
  }

  static custom(message: string): ResManScrapingError {
    return new ResManScrapingError("custom", message);
  }

  /** Mirrors the Swift `LocalizedError.errorDescription`. */
  get errorDescription(): string {
    return this.message;
  }
}

/** Type guard for the auth-required case that aborts a job. */
export function isAuthenticationRequired(error: unknown): boolean {
  return error instanceof ResManScrapingError && error.kind === "authenticationRequired";
}

/**
 * ResMan redirects an unauthenticated request to one of these login paths and
 * serves the login HTML with a 200 OK. Seeing one as the FINAL url of a data
 * request means the session expired mid-run (rather than the request failing),
 * so the response body is a login page, not data. Single source of truth for the
 * markers — both `ResManClient.isAuthenticated` and the scrape HTTP layer use it.
 */
const LOGIN_REDIRECT_MARKERS = ["/auth/Account/Login", "/Access/SignIn"] as const;

export function isResManLoginRedirect(finalUrl: string): boolean {
  return LOGIN_REDIRECT_MARKERS.some((marker) => finalUrl.includes(marker));
}
