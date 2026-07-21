import type { StaffConfig } from "@/lib/stores/config";

/**
 * Base fetch helper for the Emberly API server. Every request carries the
 * signed-in staff member's per-user `eapi_` token as a Bearer credential; the
 * server resolves the person from the token, so every call is attributed to
 * whoever is signed in.
 *
 * Feature API modules (lib/api/*.ts) build on this instead of hand-rolling
 * fetch + headers, so auth and error mapping stay one seam.
 */

/** Thrown for non-2xx responses so callers can branch on status. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Perform an authenticated request against `config.baseUrl`. `path` must start
 * with "/". Throws `ApiError` on any non-2xx status (401/403 get a dedicated
 * message so sync code can surface "not authorized" distinctly).
 */
export async function apiFetch(
  path: string,
  config: StaffConfig,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(res.status, "Not authorized for the Emberly API");
  }
  if (!res.ok) {
    throw new ApiError(res.status, `Request to ${path} failed (${res.status})`);
  }
  return res;
}

/** `apiFetch` + JSON body. The caller parses/validates (zod) the result. */
export async function apiJson<T = unknown>(
  path: string,
  config: StaffConfig,
  init?: RequestInit,
): Promise<T> {
  const res = await apiFetch(path, config, init);
  return (await res.json()) as T;
}
