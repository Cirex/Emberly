/**
 * Self-contained bill-document builder.
 *
 * MLGW serves most bills as an HTML page behind the authenticated session; only
 * some bills expose a real PDF. Historically the sync flattened those pages with
 * `htmlToText` and rendered the transcript into a hand-rolled Courier PDF, which
 * made every PDF-less bill look identical AND threw the original markup away.
 *
 * This module turns the already-fetched bill HTML into a SELF-CONTAINED
 * document: every stylesheet, image, font, and (optionally) framed sub-document
 * is fetched with the caller-supplied authenticated fetcher and inlined as a
 * `data:` URI / `<style>` block. What comes out needs no network and no cookies,
 * so it can be archived as-is and handed straight to a headless browser via
 * `page.setContent`.
 *
 * Design notes:
 *   - Pure-ish and dependency-free: the only I/O is the injected `AssetFetch`,
 *     which makes this trivially testable (see tests/mlgw-html-inliner.test.js).
 *   - Regex-driven, like the rest of the MLGW port (no DOM parser in the worker).
 *     Bill pages are simple server-rendered markup, and every failure mode here
 *     degrades to "asset omitted", never to a thrown error.
 *   - `<script>` elements, inline `on*=` handlers, and `javascript:` URLs are
 *     stripped: a captured invoice must never execute anything.
 *   - Anything that cannot be fetched (or that blows the size budget) has its
 *     reference REMOVED rather than left pointing at the network, so the archived
 *     document can never phone home.
 */

/** A fetched asset: raw bytes plus the server's content type (may be empty). */
export interface InlinedAsset {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Fetches one absolute http(s) URL with the authenticated MLGW session.
 * MUST resolve to `null` (never throw) when the asset is unavailable.
 */
export type AssetFetch = (url: string) => Promise<InlinedAsset | null>;

/** Why a referenced asset did not make it into the document. */
export type SkipReason = "unfetchable" | "oversize" | "budget";

export interface SkippedAsset {
  url: string;
  reason: SkipReason;
  /** Byte size, when known (oversize skips). */
  bytes?: number;
}

export interface SelfContainedDocument {
  /** The rewritten, network-free HTML. */
  html: string;
  inlinedAssets: number;
  inlinedBytes: number;
  skipped: SkippedAsset[];
}

export interface InlineOptions {
  /** Skip any single asset larger than this (default 5 MiB). */
  maxAssetBytes?: number;
  /** Stop inlining once this much asset data has been embedded (default 24 MiB). */
  maxDocumentBytes?: number;
  /** How deep to follow `<iframe src>` (default 1; 0 disables frame inlining). */
  maxIframeDepth?: number;
}

export const DEFAULT_MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_DOCUMENT_BYTES = 24 * 1024 * 1024;
const MAX_CSS_IMPORT_DEPTH = 3;

/** An empty, inert data URI — what a dropped `url()` reference degrades to. */
const EMPTY_DATA_URI = "data:,";

// MARK: - Small HTML/URL helpers

const NON_FETCHABLE_SCHEMES = /^(?:data|about|javascript|mailto|tel|blob|file):/i;

/** Minimal entity decode for attribute values (bill pages only use these). */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

/** Escape a string for use inside a double-quoted HTML attribute. */
export function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The value of `name` on a start tag, entity-decoded, or `null`. */
export function attributeValue(tag: string, name: string): string | null {
  const regex = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = regex.exec(tag);
  if (match === null) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/** Remove `name="…"` from a start tag. */
function withoutAttribute(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s+${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, "gi"), "");
}

/** Replace (or add) `name="value"` on a start tag. */
function withAttribute(tag: string, name: string, value: string): string {
  const stripped = withoutAttribute(tag, name);
  const selfClosing = /\/>$/.test(stripped);
  const head = stripped.slice(0, selfClosing ? -2 : -1).trimEnd();
  return `${head} ${name}="${escapeAttribute(value)}"${selfClosing ? " />" : ">"}`;
}

/**
 * `raw` resolved against `base` when it is a fetchable http(s) URL, else `null`
 * (empty values, fragments, and `data:`/`javascript:`/`mailto:` style schemes).
 */
export function resolveAssetURL(raw: string | null, base: URL): URL | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  if (NON_FETCHABLE_SCHEMES.test(trimmed)) return null;
  let resolved: URL;
  try {
    resolved = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  return resolved;
}

/** Content type for a data URI: the server's, else guessed from the path, else octet-stream. */
function assetContentType(asset: InlinedAsset, url: URL): string {
  const declared = asset.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (declared.length > 0 && declared !== "application/octet-stream") return declared;
  const extension = (url.pathname.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
  const guessed: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/x-icon",
    bmp: "image/bmp",
    css: "text/css",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    eot: "application/vnd.ms-fontobject",
  };
  return guessed[extension] ?? (declared.length > 0 ? declared : "application/octet-stream");
}

/** Async `String.replace` for a global regex. */
async function replaceAsync(
  input: string,
  regex: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(regex)] as RegExpExecArray[];
  if (matches.length === 0) return input;
  let out = "";
  let cursor = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    out += input.slice(cursor, start);
    out += await replacer(match);
    cursor = start + match[0].length;
  }
  return out + input.slice(cursor);
}

// MARK: - Script / handler stripping

const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const SCRIPT_VOID = /<script\b[^>]*\/>/gi;
const DANGLING_SCRIPT_OPEN = /<script\b[^>]*>[\s\S]*$/i;
const EVENT_HANDLER = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi;
const START_TAG = /<[a-zA-Z][^>]*>/g;
const JAVASCRIPT_HREF = /\s+(href|src|action)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s"'>]*)/gi;

/**
 * Remove every `<script>` element (including an unterminated trailing one),
 * inline `on*=` handlers, and `javascript:` URLs. A captured invoice is a
 * document, not a program.
 */
export function stripExecutableContent(html: string): string {
  const withoutScripts = html
    .replace(SCRIPT_BLOCK, "")
    .replace(SCRIPT_VOID, "")
    .replace(DANGLING_SCRIPT_OPEN, "");
  // Handlers/`javascript:` URLs are only stripped inside start tags so that page
  // text containing "onclick=" is left alone.
  return withoutScripts.replace(START_TAG, (tag) =>
    tag.replace(EVENT_HANDLER, "").replace(JAVASCRIPT_HREF, ""),
  );
}

// MARK: - Inliner

interface InlineState {
  fetchAsset: AssetFetch;
  maxAssetBytes: number;
  maxDocumentBytes: number;
  maxIframeDepth: number;
  spentBytes: number;
  inlinedAssets: number;
  skipped: SkippedAsset[];
  /** url -> data URI (or null when it could not be inlined) so each asset is fetched once. */
  cache: Map<string, string | null>;
}

function recordSkip(state: InlineState, url: string, reason: SkipReason, bytes?: number): void {
  if (state.skipped.some((entry) => entry.url === url && entry.reason === reason)) return;
  state.skipped.push(bytes === undefined ? { url, reason } : { url, reason, bytes });
}

/** Fetch + budget-check an asset, returning it or `null` (and recording the skip). */
async function loadAsset(state: InlineState, url: URL): Promise<InlinedAsset | null> {
  const key = url.toString();
  let asset: InlinedAsset | null;
  try {
    asset = await state.fetchAsset(key);
  } catch {
    asset = null;
  }
  if (asset === null) {
    recordSkip(state, key, "unfetchable");
    return null;
  }
  if (asset.bytes.length > state.maxAssetBytes) {
    recordSkip(state, key, "oversize", asset.bytes.length);
    return null;
  }
  if (state.spentBytes + asset.bytes.length > state.maxDocumentBytes) {
    recordSkip(state, key, "budget", asset.bytes.length);
    return null;
  }
  state.spentBytes += asset.bytes.length;
  state.inlinedAssets += 1;
  return asset;
}

/** An asset as a `data:` URI, memoized; `null` when it could not be inlined. */
async function dataURI(state: InlineState, url: URL): Promise<string | null> {
  const key = url.toString();
  const cached = state.cache.get(key);
  if (cached !== undefined) return cached;
  const asset = await loadAsset(state, url);
  if (asset === null) {
    state.cache.set(key, null);
    return null;
  }
  const base64 = Buffer.from(asset.bytes).toString("base64");
  const uri = `data:${assetContentType(asset, url)};base64,${base64}`;
  state.cache.set(key, uri);
  return uri;
}

/** Decode asset bytes as text (stylesheets / framed documents). */
function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

const CSS_IMPORT = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)|"([^"]*)"|'([^']*)')\s*;?/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;

/**
 * Rewrite a stylesheet so every `url()` is a data URI and every `@import` is
 * spliced in. Unfetchable references become `url("data:,")` — inert and offline.
 */
async function inlineStylesheet(
  state: InlineState,
  css: string,
  base: URL,
  importDepth: number,
): Promise<string> {
  const withImports = await replaceAsync(css, CSS_IMPORT, async (match) => {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
    const url = resolveAssetURL(raw, base);
    if (url === null || importDepth >= MAX_CSS_IMPORT_DEPTH) return "";
    const asset = await loadAsset(state, url);
    if (asset === null) return "";
    return inlineStylesheet(state, decodeText(asset.bytes), url, importDepth + 1);
  });

  return replaceAsync(withImports, CSS_URL, async (match) => {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    const trimmed = raw.trim();
    if (trimmed.startsWith("data:")) return match[0];
    const url = resolveAssetURL(raw, base);
    if (url === null) return `url("${EMPTY_DATA_URI}")`;
    const uri = await dataURI(state, url);
    return `url("${uri ?? EMPTY_DATA_URI}")`;
  });
}

const LINK_TAG = /<link\b[^>]*>/gi;
const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;
const STYLE_ATTRIBUTE = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const IMG_TAG = /<img\b[^>]*>/gi;
const IFRAME_TAG = /<iframe\b[^>]*>(?:[\s\S]*?<\/iframe\s*>)?/gi;
const IFRAME_OPEN_TAG = /^<iframe\b[^>]*>/i;
const DROPPED_ELEMENTS = /<(?:object|embed|source|track|video|audio)\b[^>]*>(?:[\s\S]*?<\/(?:object|video|audio)\s*>)?/gi;
const BASE_TAG = /<base\b[^>]*>/gi;

async function inlineDocument(
  state: InlineState,
  rawHtml: string,
  documentBase: URL,
  frameDepth: number,
): Promise<string> {
  let html = stripExecutableContent(rawHtml);

  // A <base href> changes how every relative URL resolves; honor it, then drop
  // the element so the archived copy resolves nothing at all.
  const baseHref = attributeValue(BASE_TAG.exec(html)?.[0] ?? "", "href");
  BASE_TAG.lastIndex = 0;
  let base = documentBase;
  if (baseHref !== null) {
    try {
      base = new URL(baseHref, documentBase);
    } catch {
      base = documentBase;
    }
  }
  html = html.replace(BASE_TAG, "");
  html = html.replace(DROPPED_ELEMENTS, "");

  // <link>: stylesheets become <style> blocks; every other rel (icon, preload,
  // preconnect…) is dropped rather than left pointing off-document.
  html = await replaceAsync(html, LINK_TAG, async (match) => {
    const tag = match[0];
    const rel = (attributeValue(tag, "rel") ?? "").toLowerCase();
    if (!rel.includes("stylesheet")) return "";
    const url = resolveAssetURL(attributeValue(tag, "href"), base);
    if (url === null) return "";
    const asset = await loadAsset(state, url);
    if (asset === null) return "";
    const media = attributeValue(tag, "media");
    const css = await inlineStylesheet(state, decodeText(asset.bytes), url, 0);
    const mediaAttribute = media === null ? "" : ` media="${escapeAttribute(media)}"`;
    return `<style${mediaAttribute}>\n${css}\n</style>`;
  });

  html = await replaceAsync(html, STYLE_BLOCK, async (match) => {
    const css = await inlineStylesheet(state, match[2] ?? "", base, 0);
    return `${match[1] ?? "<style>"}${css}${match[3] ?? "</style>"}`;
  });

  html = await replaceAsync(html, STYLE_ATTRIBUTE, async (match) => {
    const quote = match[2] !== undefined ? '"' : "'";
    const css = await inlineStylesheet(state, decodeEntities(match[2] ?? match[3] ?? ""), base, 0);
    return `${match[1]}${quote}${escapeAttribute(css).replace(/'/g, "&#39;")}${quote}`;
  });

  html = await replaceAsync(html, IMG_TAG, async (match) => {
    // srcset can never be inlined faithfully; drop it so `src` is authoritative.
    let tag = withoutAttribute(match[0], "srcset");
    tag = withoutAttribute(tag, "loading");
    const raw = attributeValue(tag, "src");
    // Already inline — leave it exactly as the bill page wrote it.
    if (raw !== null && raw.trim().toLowerCase().startsWith("data:")) return tag;
    const url = resolveAssetURL(raw, base);
    if (url === null) return withAttribute(tag, "src", EMPTY_DATA_URI);
    const uri = await dataURI(state, url);
    return withAttribute(tag, "src", uri ?? EMPTY_DATA_URI);
  });

  html = await replaceAsync(html, IFRAME_TAG, async (match) => {
    const tag = match[0];
    if (frameDepth >= state.maxIframeDepth) return "";
    const url = resolveAssetURL(attributeValue(tag, "src"), base);
    if (url === null) return "";
    const asset = await loadAsset(state, url);
    if (asset === null) return "";
    const inner = await inlineDocument(state, decodeText(asset.bytes), url, frameDepth + 1);
    const openTag = withoutAttribute(IFRAME_OPEN_TAG.exec(tag)?.[0] ?? "<iframe>", "src");
    return `${withAttribute(openTag, "srcdoc", inner)}</iframe>`;
  });

  return html;
}

/** Ensure the archived file declares UTF-8 so it decodes identically off-line. */
function withCharsetMeta(html: string): string {
  if (/<meta\b[^>]*charset/i.test(html)) return html;
  const meta = '<meta charset="utf-8">';
  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (headOpen !== null) {
    const at = (headOpen.index ?? 0) + headOpen[0].length;
    return `${html.slice(0, at)}${meta}${html.slice(at)}`;
  }
  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen !== null) {
    const at = (htmlOpen.index ?? 0) + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${meta}</head>${html.slice(at)}`;
  }
  return `${meta}${html}`;
}

/**
 * Build the self-contained, network-free copy of a bill page.
 *
 * Never throws: an asset that cannot be fetched, is larger than
 * `maxAssetBytes`, or would push the document past `maxDocumentBytes` is
 * omitted and reported in `skipped`.
 */
export async function buildSelfContainedDocument(
  html: string,
  baseUrl: string | URL,
  fetchAsset: AssetFetch,
  options: InlineOptions = {},
): Promise<SelfContainedDocument> {
  let base: URL;
  try {
    base = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
  } catch {
    base = new URL("https://mymlgw.mlgw.org/");
  }

  const state: InlineState = {
    fetchAsset,
    maxAssetBytes: options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES,
    maxDocumentBytes: options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
    maxIframeDepth: options.maxIframeDepth ?? 1,
    spentBytes: 0,
    inlinedAssets: 0,
    skipped: [],
    cache: new Map(),
  };

  const inlined = await inlineDocument(state, html, base, 0);
  return {
    html: withCharsetMeta(inlined),
    inlinedAssets: state.inlinedAssets,
    inlinedBytes: state.spentBytes,
    skipped: state.skipped,
  };
}

/** One-line summary of what was omitted, for the sync log. */
export function describeSkippedAssets(skipped: SkippedAsset[], limit = 3): string {
  if (skipped.length === 0) return "";
  const head = skipped
    .slice(0, limit)
    .map((entry) => `${entry.reason}:${entry.url}${entry.bytes === undefined ? "" : ` (${entry.bytes}B)`}`)
    .join(", ");
  return skipped.length > limit ? `${head}, +${skipped.length - limit} more` : head;
}
