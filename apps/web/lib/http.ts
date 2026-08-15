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
 * Decoded size of a base64 string, WITHOUT decoding it.
 *
 * The photo upload paths used to `Buffer.from(dataBase64, "base64")` and then
 * check the result against their byte cap — so an oversized payload was fully
 * materialized (parsed string + decoded Buffer) before being rejected. Four
 * base64 characters encode three bytes; trailing `=` padding encodes none.
 */
export function base64ByteLength(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

export type LimitedJsonResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: "too_large" | "invalid" };

/**
 * `request.json()` with a hard ceiling on the body.
 *
 * App Router route handlers have NO built-in body limit (unlike the Pages
 * Router's old 1MB `bodyParser.sizeLimit`), so an unbounded `await
 * request.json()` buffers whatever the client sends before any validation can
 * look at it. Zod caps on the parsed shape are too late — the allocation has
 * already happened.
 *
 * `content-length` is checked first as a cheap reject, then the stream is read
 * with a running total so a chunked or lying body is cut off at the same
 * ceiling rather than trusted.
 */
export async function readJsonWithinLimit(
  request: Request,
  maxBytes: number
): Promise<LimitedJsonResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  const stream = request.body;
  if (!stream) {
    // No readable stream (some test doubles, and bodyless requests). Fall back
    // to the plain parse — content-length has already been checked.
    const parsed = await readJson(request);
    return parsed.ok ? { ok: true, body: parsed.body } : { ok: false, reason: "invalid" };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "invalid" };
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(joined)) };
  } catch {
    return { ok: false, reason: "invalid" };
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
