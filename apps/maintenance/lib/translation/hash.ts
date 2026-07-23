/**
 * A short, stable content hash for keying translation-cache entries.
 *
 * FNV-1a (32-bit) rendered base-36 — deterministic, dependency-free, and fast.
 * It keys the cache to the SOURCE text, so an edited work order changes its hash
 * and re-translates on the next sync while the prior translation stays valid for
 * anything still showing the old text. Not cryptographic; collision odds across
 * one property's work-order corpus are negligible.
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
