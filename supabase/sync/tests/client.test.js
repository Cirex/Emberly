
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ResManClient,
  extractRequestVerificationToken,
  extractDXCss,
  formURLEncode,
  parseOidcFormPost,
} = require("../src/resman/client");
const { MULTI_SOUTH_CONFIGURATION } = require("../src/resman/config");

const noNetwork = () => {
  throw new Error("network must not be called in this test");
};

function makeClient(fetchImpl = noNetwork) {
  return new ResManClient(MULTI_SOUTH_CONFIGURATION, { fetchImpl });
}

// MARK: - extractToken (ported from ResManClientTests)

test("extractToken: standard login page HTML", () => {
  const html = '<input name="__RequestVerificationToken" type="hidden" value="abc123XYZ" />';
  assert.equal(makeClient().extractToken(html), "abc123XYZ");
  assert.equal(extractRequestVerificationToken(html), "abc123XYZ");
});

test("extractToken: value attribute before name attribute", () => {
  const html = '<input name="__RequestVerificationToken" value="tokenReversed" type="hidden" />';
  assert.equal(makeClient().extractToken(html), "tokenReversed");
});

test("extractToken: meta-tag variant (SPA pages)", () => {
  const html = '<meta name="RequestVerificationToken" content="meta-token" />';
  assert.equal(extractRequestVerificationToken(html), "meta-token");
});

test("extractToken: throws when the token is absent", () => {
  assert.throws(() => makeClient().extractToken("<html><body>No token here</body></html>"));
});

test("extractToken: throws on empty HTML", () => {
  assert.throws(() => makeClient().extractToken(""));
});

// MARK: - formURLEncode (ported from ResManClientTests)

test("formURLEncode: simple key-value pairs", () => {
  assert.equal(
    formURLEncode([
      ["Username", "alice"],
      ["Password", "secret"],
    ]),
    "Username=alice&Password=secret",
  );
});

test("formURLEncode: percent-encodes spaces as %20 (never +)", () => {
  const result = formURLEncode([
    ["q", "hello world"],
    ["a", "a+b=c"],
  ]);
  assert.ok(!result.includes(" "));
  assert.ok(!result.includes("+"));
  assert.ok(result.startsWith("q=hello%20world"));
});

test("formURLEncode: empty input yields empty string", () => {
  assert.equal(formURLEncode([]), "");
});

test("formURLEncode: encodes slashes and equals in a token value", () => {
  const result = formURLEncode([["__RequestVerificationToken", "CfDJ8K/abc==XYZ"]]);
  assert.ok(!result.includes("/"));
  const afterFirst = result.slice(result.indexOf("=") + 1);
  assert.ok(!afterFirst.includes("="));
});

// MARK: - extractDXCss (ported from ResManClientTests)

test("extractDXCss: extracts CSS href links", () => {
  const html = `
    <link rel="stylesheet" href="/Content/themes/base/jquery-ui.css" />
    <link rel="stylesheet" href="/bundles/DXWebResources.css" />`;
  const result = extractDXCss(html);
  assert.ok(result.includes("/Content/themes/base/jquery-ui.css"));
  assert.ok(result.includes("/bundles/DXWebResources.css"));
});

test("extractDXCss: extracts DXR resource IDs", () => {
  const html = `
    <script src="/DXR.axd?r=abc123"></script>
    <script src="/DXR.axd?r=def456"></script>`;
  const result = extractDXCss(html);
  assert.ok(result.includes("abc123"));
  assert.ok(result.includes("def456"));
});

test("extractDXCss: deduplicates repeated DXR IDs", () => {
  const html = `
    <script src="/DXR.axd?r=same"></script>
    <script src="/DXR.axd?r=same"></script>`;
  const parts = extractDXCss(html).split(",");
  assert.equal(parts.filter((p) => p === "same").length, 1);
});

test("extractDXCss: empty string when there are no assets", () => {
  assert.equal(extractDXCss("<html></html>"), "");
});

// MARK: - completeOIDC parsing (ported from ResManClientTests)

test("completeOIDC: throws when no form action is present", async () => {
  await assert.rejects(makeClient().completeOIDC("<html><body><p>No form here</p></body></html>"));
});

test("completeOIDC: throws on invalid-credentials response (empty action)", async () => {
  const html = '<form method="post" action=""><input type="hidden" name="code" value="abc" /></form>';
  await assert.rejects(makeClient().completeOIDC(html));
});

test("completeOIDC: throws when hidden inputs are missing", async () => {
  const html = '<form method="post" action="https://consumer.example.com/signin-oidc"></form>';
  await assert.rejects(makeClient().completeOIDC(html));
});

test("parseOidcFormPost: decodes entities in the action URL and collects inputs", () => {
  const html = `
    <form action="https://multisouth.myresman.com/signin-oidc?a=1&amp;b=2">
      <input type="hidden" name="code" value="oidc-code" />
      <input type="hidden" name="state" value="st" />
    </form>`;
  const { action, fields } = parseOidcFormPost(html);
  assert.equal(action, "https://multisouth.myresman.com/signin-oidc?a=1&b=2");
  assert.deepEqual(fields, [
    ["code", "oidc-code"],
    ["state", "st"],
  ]);
});

// MARK: - connectionsPerHost knob

test("connectionsPerHost is configurable (rate-limit knob)", () => {
  const client = new ResManClient(MULTI_SOUTH_CONFIGURATION, { fetchImpl: noNetwork, connectionsPerHost: 64 });
  assert.equal(client.connectionsPerHost, 64);
});

// MARK: - Offline end-to-end login replay
//
// Structures the deferred live smoke test (design §7 / M2) against an injected
// fake ResMan, exercising the full 3-step OIDC replay, manual redirect
// following, ReturnUrl extraction, and cookie capture — with no real network.

const AUTH_LOGIN_URL =
  "https://multisouth.auth.myresman.com/auth/Account/Login?ReturnUrl=%2Fconnect%2Fauthorize";
const SIGNIN_OIDC_URL = "https://multisouth.myresman.com/signin-oidc";

function makeFakeResman() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    const cookie = init.headers?.cookie ?? "";
    const body = init.body;
    calls.push({ url: u, method, body });

    // GET consumer root: authenticated only once the session cookie is set.
    if (method === "GET" && u === MULTI_SOUTH_CONFIGURATION.consumerStartUrl) {
      if (cookie.includes(".AspNetCore.Cookies")) {
        return new Response("<html>dashboard</html>", { status: 200 });
      }
      return new Response(null, { status: 302, headers: { location: AUTH_LOGIN_URL } });
    }

    // GET the auth login page: token + antiforgery cookie.
    if (method === "GET" && u === AUTH_LOGIN_URL) {
      return new Response(
        '<input name="__RequestVerificationToken" type="hidden" value="tok-123" />',
        { status: 200, headers: { "content-type": "text/html", "set-cookie": ".AspNetCore.Antiforgery=af-1; path=/" } },
      );
    }

    // POST credentials to the login URL: returns the auto-submitting form_post.
    if (method === "POST" && u === AUTH_LOGIN_URL) {
      return new Response(
        `<form method="post" action="${SIGNIN_OIDC_URL}">
           <input type="hidden" name="code" value="oidc-code" />
           <input type="hidden" name="id_token" value="jwt" />
         </form>`,
        { status: 200 },
      );
    }

    // POST to signin-oidc: sets the session cookie.
    if (method === "POST" && u === SIGNIN_OIDC_URL) {
      return new Response(null, {
        status: 200,
        headers: { "set-cookie": ".AspNetCore.Cookies=sess-abc; path=/; HttpOnly" },
      });
    }

    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

test("login replays the OIDC flow, sends encoded credentials, and captures the session cookie", async () => {
  const { fetchImpl, calls } = makeFakeResman();
  const client = new ResManClient(MULTI_SOUTH_CONFIGURATION, { fetchImpl });

  await client.login("testuser", "testpass");

  // Credentials were posted to the auth login URL, form-url-encoded.
  const credentialPost = calls.find((c) => c.method === "POST" && c.url === AUTH_LOGIN_URL);
  assert.ok(credentialPost, "expected a credential POST");
  assert.ok(credentialPost.body.includes("Username=testuser"));
  assert.ok(credentialPost.body.includes("Password=testpass"));
  assert.ok(credentialPost.body.includes("AccountId=1659"));
  assert.ok(credentialPost.body.includes("CompanyName=The%20Multi-South%20Group"));
  // ReturnUrl was extracted from the login URL's query and echoed back.
  assert.ok(credentialPost.body.includes("ReturnUrl=%2Fconnect%2Fauthorize"));

  // The OIDC form_post was replayed to signin-oidc with its hidden inputs.
  const oidcPost = calls.find((c) => c.method === "POST" && c.url === SIGNIN_OIDC_URL);
  assert.ok(oidcPost);
  assert.ok(oidcPost.body.includes("code=oidc-code"));

  // The session cookie is now in the jar.
  assert.ok(client.cookieJar.all().some((c) => c.name === ".AspNetCore.Cookies"));
});

test("isAuthenticated flips false→true across a login", async () => {
  const { fetchImpl } = makeFakeResman();
  const client = new ResManClient(MULTI_SOUTH_CONFIGURATION, { fetchImpl });

  assert.equal(await client.isAuthenticated(), false);
  await client.login("u", "p");
  assert.equal(await client.isAuthenticated(), true);
});

test("ensureAuthenticated logs in once, then is a no-op while the session is valid", async () => {
  const { fetchImpl, calls } = makeFakeResman();
  const { InMemorySessionStorage, ResManSessionStore } = require("../src/resman/session-store");
  const client = new ResManClient(MULTI_SOUTH_CONFIGURATION, {
    fetchImpl,
    sessionStore: new ResManSessionStore(new InMemorySessionStorage()),
    credentials: { username: "u", password: "p" },
  });

  await client.ensureAuthenticated();
  const loginPostsAfterFirst = calls.filter((c) => c.method === "POST" && c.url === SIGNIN_OIDC_URL).length;
  assert.equal(loginPostsAfterFirst, 1);

  await client.ensureAuthenticated();
  const loginPostsAfterSecond = calls.filter((c) => c.method === "POST" && c.url === SIGNIN_OIDC_URL).length;
  assert.equal(loginPostsAfterSecond, 1, "second ensureAuthenticated should not re-login");
});

test("ensureAuthenticated fails closed without credentials", async () => {
  const { fetchImpl } = makeFakeResman();
  const client = new ResManClient(MULTI_SOUTH_CONFIGURATION, { fetchImpl });
  await assert.rejects(client.ensureAuthenticated());
});
