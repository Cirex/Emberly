/**
 * Canonical content hash for translation-cache keys, shared by the maintenance
 * app (on-device Apple pipeline) and the sync worker (server-side Langbly
 * pipeline). Both key translations by `${lang}:${textHash(source)}`, so the
 * server can pre-compute a translation the device downloads and reuses without
 * re-translating — but only if this function produces byte-identical output in
 * both places. That is what the parity test locks down.
 *
 * FNV-1a (32-bit) rendered base-36 — deterministic, dependency-free, fast, not
 * cryptographic. Collision odds across one property's work-order corpus are
 * negligible.
 */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts, kept unsigned.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The cache key a translation is stored/looked up under. */
export function translationKey(lang: string, source: string): string {
  return `${lang}:${textHash(source)}`;
}
