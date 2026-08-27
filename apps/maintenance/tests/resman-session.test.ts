import { describe, expect, mock, test } from "bun:test";

/**
 * The device-held ResMan session: the 3-step staff OIDC login as React
 * Native's fetch experiences it — redirects auto-followed, cookies handled by
 * the native stack, the only JS-visible signals being `response.url` and the
 * HTML bodies. The scripted transports here reproduce exactly those signals,
 * as captured live on 2026-08-26.
 */

const secure = new Map<string, string>();
mock.module("expo-secure-store", () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void secure.set(k, v),
  deleteItemAsync: async (k: string) => void secure.delete(k),
}));
mock.module("@/lib/analytics", () => ({
  capture: () => {},
  identify: () => {},
  resetAnalytics: () => {},
}));

const { performDeviceLogin, probeSession, returnUrlFromLoginUrl } = await import(
  "@/lib/resman/session"
);

const LOGIN_URL =
  "https://multisouth.auth.myresman.com/auth/Account/Login?ReturnUrl=%2Fauth%2Fconnect%2Fauthorize";
const LOGIN_HTML =
  '<html><form><input name="__RequestVerificationToken" type="hidden" value="tok123" /></form></html>';
const FORM_POST_HTML =
  '<html><form action="https://multisouth.myresman.com/signin-oidc">' +
  '<input name="id_token" value="jwt.here" /><input name="state" value="abc" /></form></html>';
const RELOGIN_HTML =
  '<html><form action="/auth/Account/Login"><input name="__RequestVerificationToken" value="tok" /></form>Invalid</html>';

function response(url: string, body: string): Response {
  return { url, status: 200, text: async () => body } as unknown as Response;
}

describe("returnUrlFromLoginUrl", () => {
  test("decodes the ReturnUrl query without the URL API", () => {
    expect(returnUrlFromLoginUrl(LOGIN_URL)).toBe("/auth/connect/authorize");
    expect(returnUrlFromLoginUrl("https://x/Login")).toBe("");
  });
});

describe("performDeviceLogin", () => {
  test("happy path: bootstrap → credentials → form_post replay", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string });
      if (calls.length === 1) return response(LOGIN_URL, LOGIN_HTML); // auto-followed to login
      if (calls.length === 2) return response(LOGIN_URL, FORM_POST_HTML); // creds accepted
      return response("https://multisouth.myresman.com/", "<html>home</html>"); // oidc replay landed
    }) as unknown as typeof fetch;

    const result = await performDeviceLogin("tech@multi-south.com", "hunter2", fetchImpl);
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    // The credential POST carries the portal constants, the decoded ReturnUrl,
    // and the harvested token — percent-encoded the way ResMan requires.
    expect(calls[1].method).toBe("POST");
    expect(calls[1].body).toContain("AccountId=1659");
    expect(calls[1].body).toContain("ReturnUrl=%2Fauth%2Fconnect%2Fauthorize");
    expect(calls[1].body).toContain("Username=tech%40multi-south.com");
    expect(calls[1].body).toContain("__RequestVerificationToken=tok123");
    // The form_post replay goes to the absolute signin-oidc action with the
    // hidden fields.
    expect(calls[2].url).toBe("https://multisouth.myresman.com/signin-oidc");
    expect(calls[2].body).toContain("id_token=jwt.here");
  });

  test("wrong credentials: the re-rendered login form reads as invalid", async () => {
    let count = 0;
    const fetchImpl = (async () => {
      count += 1;
      if (count === 1) return response(LOGIN_URL, LOGIN_HTML);
      return response(LOGIN_URL, RELOGIN_HTML); // relative action = rejected
    }) as unknown as typeof fetch;
    const result = await performDeviceLogin("tech", "wrong", fetchImpl);
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(count).toBe(2); // never replayed a form_post that was not one
  });

  test("a lingering session on bootstrap refuses rather than adopting it", async () => {
    // establish() signs out first; landing on the consumer root here means
    // the sign-out failed and WHOSE session this is is unknown.
    const fetchImpl = (async () =>
      response("https://multisouth.myresman.com/", "<html>home</html>")) as unknown as typeof fetch;
    const result = await performDeviceLogin("tech", "pw", fetchImpl);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  test("network failure is unreachable, never a throw", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await performDeviceLogin("tech", "pw", fetchImpl)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});

describe("probeSession", () => {
  test("authenticated when the consumer root serves; expired on the login bounce", async () => {
    const home = (async () =>
      response("https://multisouth.myresman.com/", "<html>home</html>")) as unknown as typeof fetch;
    const bounced = (async () => response(LOGIN_URL, LOGIN_HTML)) as unknown as typeof fetch;
    expect(await probeSession(home)).toBe(true);
    expect(await probeSession(bounced)).toBe(false);
  });
});
