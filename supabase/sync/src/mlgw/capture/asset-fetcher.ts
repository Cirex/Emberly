/**
 * The authenticated `AssetFetch` used when inlining a bill page.
 *
 * Bill stylesheets/images/fonts live behind the same MLGW session as the bill
 * itself, so they must be fetched with the SAME authenticated client that
 * fetched the page — an unauthenticated fetch gets the login redirect, not the
 * asset. Failures resolve to `null`, which the inliner treats as "omit this
 * asset"; nothing here can throw into the bill download.
 */

import type { MLGWHTTPClient } from "../http";
import type { AssetFetch, InlinedAsset } from "./html-inliner";

/** Assets are small; don't let one hung request stall a bill. */
const ASSET_TIMEOUT_MS = 15_000;

export function httpAssetFetcher(client: MLGWHTTPClient, referer?: string): AssetFetch {
  return async (url: string): Promise<InlinedAsset | null> => {
    try {
      const response = await client.request("GET", url, {
        headers: referer === undefined ? {} : { Referer: referer },
        timeoutMs: ASSET_TIMEOUT_MS,
      });
      if (response.status < 200 || response.status >= 300) return null;
      if (response.bytes.length === 0) return null;
      return { bytes: response.bytes, contentType: response.headers["content-type"] ?? "" };
    } catch {
      return null;
    }
  };
}
