/**
 * Reads and parses a JSON request body without throwing on malformed input.
 */
export async function readJson(
  request: Request
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

/**
 * Best-effort request source identifier for rate-limit buckets. Trusts the
 * first x-forwarded-for hop (set by the hosting platform), then x-real-ip.
 */
export function requestSource(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}
