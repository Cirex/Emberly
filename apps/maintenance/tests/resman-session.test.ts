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
const cookieSets: unknown[][] = [];
mock.module("@react-native-cookies/cookies", () => ({
  default: {
    set: async (...args: unknown[]) => {
      cookieSets.push(args);
      return true;
    },
    clearAll: async () => true,
  },
}));
mock.module("@/lib/analytics", () => ({
  capture: () => {},
  identify: () => {},
  resetAnalytics: () => {},
}));

const { performDeviceLogin, probeSession, remoteSignOut, returnUrlFromLoginUrl, useResManSession } =
  await import("@/lib/resman/session");

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

  test("a lingering session on bootstrap reports already_authenticated", async () => {
    // Landing on the consumer root means the prior sign-out has not
    // propagated. performDeviceLogin never adopts the unknown identity —
    // establish() owns the retry (one more sign-out round, then refuse).
    const fetchImpl = (async () =>
      response("https://multisouth.myresman.com/", "<html>home</html>")) as unknown as typeof fetch;
    const result = await performDeviceLogin("tech", "pw", fetchImpl);
    expect(result).toEqual({ ok: false, reason: "already_authenticated" });
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
    expect(await probeSession(home)).toBe("active");
    expect(await probeSession(bounced)).toBe("expired");
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    // Offline is NOT expired — treating it as expired would kick a tech in a
    // no-signal basement to a login screen they cannot use.
    expect(await probeSession(offline)).toBe("unreachable");
  });
});

describe("sign-out responsiveness", () => {
  test("remoteSignOut returns at the deadline even when the request hangs", async () => {
    // The regression this pins: an unbounded await on /Access/SignOut sat in
    // front of the Sign out button and made it look dead for up to 60s.
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const start = Date.now();
    await remoteSignOut(hanging, 50);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test("store signOut clears local state instantly, never awaiting the network", async () => {
    const realFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      networkCalls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    try {
      useResManSession.setState({ status: "active", username: "tech", hydrated: true });
      const start = Date.now();
      await useResManSession.getState().signOut();
      expect(Date.now() - start).toBeLessThan(2_000);
      expect(useResManSession.getState().status).toBe("absent");
      expect(useResManSession.getState().username).toBe("");
      expect(networkCalls).toBe(1); // fired, in the background
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("silent renewal", () => {
  const CREDS_KEY = "emberly_resman_credentials";
  const HOME = "https://multisouth.myresman.com/";

  /** A transport that answers: probe → login bounce, then a full successful
   *  login dance (bootstrap → creds → form_post replay). */
  function renewalTransport() {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "GET" && url === HOME) {
        // First GET is the probe, second is the login bootstrap — both bounce
        // to the login page (that is exactly what an expired session does).
        return response(LOGIN_URL, LOGIN_HTML);
      }
      if (method === "POST" && url.includes("/api/admin/auth/resman-session")) {
        throw new Error("server unreachable"); // exercises the device fallback
      }
      if (method === "POST" && url === LOGIN_URL) return response(LOGIN_URL, FORM_POST_HTML);
      if (method === "POST") return response(HOME, "<html>home</html>");
      throw new Error(`unscripted ${method} ${url}`);
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test("verify: an expired session renews via the SERVER session endpoint", async () => {
    secure.set(CREDS_KEY, JSON.stringify({ username: "tech", password: "pw" }));
    useResManSession.setState({ status: "active", username: "tech", canRenew: true, hydrated: true });
    cookieSets.length = 0;
    let probes = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/api/admin/auth/resman-session")) {
        return {
          url,
          status: 200,
          json: async () => ({
            ok: true,
            cookies: [
              { name: "s", value: "v", domain: "multisouth.myresman.com", path: "/", expires: null },
            ],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      // Probes: first sees the bounce (expired), the post-inject one sees home.
      probes += 1;
      return probes === 1
        ? response(LOGIN_URL, LOGIN_HTML)
        : response("https://multisouth.myresman.com/", "<html>home</html>");
    }) as unknown as typeof fetch;
    const alive = await useResManSession.getState().verify(fetchImpl);
    expect(alive).toBe(true);
    expect(useResManSession.getState().status).toBe("active");
    expect(cookieSets.length).toBe(1); // the server cookie was injected natively
  });

  test("verify: server unreachable falls back to the on-device dance", async () => {
    secure.set(CREDS_KEY, JSON.stringify({ username: "tech", password: "pw" }));
    useResManSession.setState({ status: "active", username: "tech", canRenew: true, hydrated: true });
    const { calls, fetchImpl } = renewalTransport(); // server endpoint throws → unreachable
    const alive = await useResManSession.getState().verify(fetchImpl);
    expect(alive).toBe(true);
    expect(useResManSession.getState().status).toBe("active");
    // Server attempt, then the dance's creds POST + oidc POST.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(3);
  });

  test("renew: rejected credentials are wiped and the kick gate opens", async () => {
    secure.set(CREDS_KEY, JSON.stringify({ username: "tech", password: "rotated" }));
    useResManSession.setState({
      status: "expired",
      username: "tech",
      canRenew: true,
      hydrated: true,
    });
    let posts = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/api/admin/auth/resman-session")) {
        posts += 1;
        return { url, status: 401, json: async () => ({}), text: async () => "" } as unknown as Response;
      }
      if (method === "GET") return response(LOGIN_URL, LOGIN_HTML);
      posts += 1;
      return response(LOGIN_URL, RELOGIN_HTML); // creds rejected
    }) as unknown as typeof fetch;
    const renewed = await useResManSession.getState().renew(fetchImpl);
    expect(renewed).toBe(false);
    // The server 401 is definitive — no device-dance retry with bad creds.
    expect(posts).toBe(1);
    expect(secure.has(CREDS_KEY)).toBe(false);
    expect(useResManSession.getState().canRenew).toBe(false);
  });

  test("renew: no stored credentials is a quiet false, no network", async () => {
    secure.delete(CREDS_KEY);
    useResManSession.setState({
      status: "expired",
      username: "tech",
      canRenew: true,
      hydrated: true,
    });
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    expect(await useResManSession.getState().renew(fetchImpl)).toBe(false);
    expect(useResManSession.getState().canRenew).toBe(false);
  });

  test("signOut wipes the Keychain credentials with the session", async () => {
    secure.set(CREDS_KEY, JSON.stringify({ username: "tech", password: "pw" }));
    useResManSession.setState({
      status: "active",
      username: "tech",
      canRenew: true,
      hydrated: true,
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      url: "x",
      status: 200,
      text: async () => "",
    })) as unknown as typeof fetch;
    try {
      await useResManSession.getState().signOut();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(secure.has(CREDS_KEY)).toBe(false);
    expect(useResManSession.getState().canRenew).toBe(false);
  });
});
