/**
 * MLGW SAML SSO login + billing-portal navigation. Port of
 * KrakenCore/Services/MLGW/MLGWPortalSession.swift.
 *
 * establishSsoSession runs the My MLGW SAML flow (session probe → login form →
 * username/password → SAMLResponse relay), following meta/JS HTML redirects and
 * the "missing cookie" retry. openBillingPortal auto-submits the intermediate
 * SSO/biller forms until the billing workspace (or a PDF) is reached.
 */
import { myMLGWSsoLoginURL, myMLGWSsoSessionURL, billPaySsoURL } from "../env";
import type { MLGWHTTPClient } from "../http";
import { type HTTPResponse, ScriptError } from "../types";
import { attributes, cachedRegex, htmlLinks, resolveURL } from "../text";
import { type HTMLForm, parseForms, submitForm } from "./forms";

/** The `cookieTime` retry link on a "missing cookie" interstitial. Port of `retryURLFromMissingCookiePage`. */
export function retryURLFromMissingCookiePage(html: string, baseURL: URL): URL | null {
  if (!html.toLowerCase().includes("missing cookie")) return null;
  const regex = cachedRegex("<a\\b([^>]*)>(.*?)</a>", "gis");
  for (const match of html.matchAll(regex)) {
    const attrs = attributes(match[1] ?? "");
    const href = attrs["href"];
    if (href !== undefined && href.includes("cookieTime")) {
      return resolveURL(href, baseURL);
    }
  }
  return null;
}

/** The `<meta http-equiv=refresh>` URL or the `#redirLink` anchor. Port of `htmlRedirectURL`. */
export function htmlRedirectURL(html: string, baseURL: URL): URL | null {
  const regex = cachedRegex("<meta\\b([^>]*)>", "gis");
  for (const match of html.matchAll(regex)) {
    const attrs = attributes(match[1] ?? "");
    if (attrs["http-equiv"]?.toLowerCase() !== "refresh") continue;
    const content = attrs["content"];
    if (content === undefined) continue;
    const urlMatch = /\burl\s*=/i.exec(content);
    if (urlMatch === null) continue;
    const rawURL = content
      .slice(urlMatch.index + urlMatch[0].length)
      .trim()
      .replace(/^["']+|["']+$/g, "");
    const url = resolveURL(rawURL, baseURL);
    if (url !== null) return url;
  }

  const redir = htmlLinks(html, baseURL).find((link) => link.attributes["id"]?.toLowerCase() === "redirlink");
  return redir?.url ?? null;
}

/** Follow chained HTML (meta/JS) redirects, up to `maxRedirects`. Port of `followHTMLRedirects`. */
export async function followHTMLRedirects(
  client: MLGWHTTPClient,
  response: HTTPResponse,
  maxRedirects = 5,
): Promise<HTTPResponse> {
  let current = response;
  const visited = new Set<string>();
  for (let i = 0; i < maxRedirects; i += 1) {
    if (current.isPdf) return current;
    const nextURL = htmlRedirectURL(current.text, new URL(current.url));
    if (nextURL === null) return current;
    const key = nextURL.toString();
    if (visited.has(key)) return current;
    visited.add(key);
    current = await client.request("GET", nextURL);
  }
  return current;
}

/** Run the full My MLGW SAML SSO login. Port of `establishSsoSession`. */
export async function establishSsoSession(
  client: MLGWHTTPClient,
  username: string,
  password: string,
): Promise<void> {
  try {
    await client.request("GET", myMLGWSsoSessionURL, { headers: { Accept: "application/json" } });
  } catch {
    /* session probe is best-effort (Swift `try?`) */
  }

  let first = await client.request("GET", myMLGWSsoLoginURL);
  first = await followHTMLRedirects(client, first);
  const retryURL = retryURLFromMissingCookiePage(first.text, new URL(first.url));
  if (retryURL !== null) {
    first = await client.request("GET", retryURL);
    first = await followHTMLRedirects(client, first);
  }

  const firstForm = parseForms(first.text, new URL(first.url))[0];
  if (firstForm === undefined) {
    throw ScriptError.ssoFailed(
      `Could not find the My MLGW SSO login form after HTTP ${first.status} from ${first.url}.`,
    );
  }

  if (firstForm.fields["SAMLResponse"] !== undefined) {
    await submitForm(client, firstForm);
    return;
  }

  const loginResponse = await followHTMLRedirects(
    client,
    await submitForm(client, firstForm, { username, password }),
  );
  const samlForm = parseForms(loginResponse.text, new URL(loginResponse.url)).find(
    (form) => form.fields["SAMLResponse"] !== undefined,
  );
  if (samlForm === undefined) {
    throw ScriptError.ssoFailed(
      `Could not find SAMLResponse after submitting username/password. HTTP ${loginResponse.status} from ${loginResponse.url}.`,
    );
  }
  await submitForm(client, samlForm);
}

/** Whether an intermediate SSO/biller form should be auto-submitted. Port of `shouldAutoSubmit`. */
export function shouldAutoSubmit(form: HTMLForm): boolean {
  const action = form.action.toString().toLowerCase();
  const text = form.text.toLowerCase();
  if (form.fields["SAMLResponse"] !== undefined) return true;
  if (text.includes("continue") || text.includes("retrieving information")) return true;
  if (action.includes("secure3.billerweb.com")) return true;
  if (form.fields["authTkn"] !== undefined || form.fields["keyTkn"] !== undefined) return true;
  return false;
}

/** Open the bill-pay portal, auto-submitting SSO relay forms. Port of `openBillingPortal`. */
export async function openBillingPortal(client: MLGWHTTPClient): Promise<HTTPResponse> {
  let response = await client.request("GET", billPaySsoURL);
  response = await followHTMLRedirects(client, response);
  for (let i = 0; i < 10; i += 1) {
    if (response.isPdf) return response;
    const form = parseForms(response.text, new URL(response.url)).find(shouldAutoSubmit);
    if (form === undefined) return response;
    response = await submitForm(client, form);
    response = await followHTMLRedirects(client, response);
  }
  return response;
}
