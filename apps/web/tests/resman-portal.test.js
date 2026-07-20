
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCookieHeader,
  isSuccessfulResmanLogin,
  parseResidentNameFromPortalHtml,
  parseTransactionsAccess,
  parseSignInForm,
  resmanPortalLogin,
  verifyResmanPortalAccess,
  serializeCookiesForClient,
} = require("../lib/resman-portal");

test("parseSignInForm extracts the required Emberly sign-in fields", () => {
  const html = `
    <form action="/Portal/Access/SignIn/Emberly" method="post">
      <input id="AccountID" name="AccountID" type="hidden" value="1659" />
      <input id="PropertyName" name="PropertyName" type="hidden" value="Emberly Apartments" />
      <input id="ReturnUrl" name="ReturnUrl" type="hidden" value="" />
      <input id="PropertyID" name="PropertyID" type="hidden" value="489f05ba-6bd4-4888-9460-88923577a6eb" />
      <input id="ShowChangeLink" name="ShowChangeLink" type="hidden" value="False" />
      <input name="__RequestVerificationToken" type="hidden" value="csrf-token" />
    </form>
  `;

  assert.deepEqual(parseSignInForm(html), {
    action: "/Portal/Access/SignIn/Emberly",
    fields: {
      AccountID: "1659",
      PropertyName: "Emberly Apartments",
      ReturnUrl: "",
      PropertyID: "489f05ba-6bd4-4888-9460-88923577a6eb",
      ShowChangeLink: "False",
      __RequestVerificationToken: "csrf-token",
    },
  });
});

// Characterization: the resident-portal parsers HTML-entity-decode the values
// they pull out of ResMan markup. Pins current behavior before the decoder is
// hoisted into lib/resman-html.ts so the refactor can't silently change it.
test("parseSignInForm decodes HTML entities in the form action and field values", () => {
  const html = `
    <form action="/Portal/Access/SignIn/Emberly?a=1&amp;b=2" method="post">
      <input name="AccountID" type="hidden" value="1659" />
      <input name="PropertyName" type="hidden" value="Emberly &amp; Sons &lt;LLC&gt;" />
      <input name="ReturnUrl" type="hidden" value="" />
      <input name="PropertyID" type="hidden" value="O&#39;Neil &quot;Court&quot;" />
      <input name="__RequestVerificationToken" type="hidden" value="tok" />
    </form>
  `;

  const parsed = parseSignInForm(html);
  assert.equal(parsed.action, "/Portal/Access/SignIn/Emberly?a=1&b=2");
  assert.equal(parsed.fields.PropertyName, "Emberly & Sons <LLC>");
  assert.equal(parsed.fields.PropertyID, "O'Neil \"Court\"");
});

test("parseResidentNameFromPortalHtml decodes HTML entities in the resident name", () => {
  assert.equal(
    parseResidentNameFromPortalHtml(
      `<input id="LoggedInPersonName" name="LoggedInPersonName" type="hidden" value="D&#39;Angelo O&amp;B">`
    ),
    "D'Angelo O&B"
  );
  assert.equal(
    parseResidentNameFromPortalHtml(`
      <div id="HeaderRight"><span>AT&amp;T &lt;Holdings&gt;</span></div>
    `),
    "AT&T <Holdings>"
  );
});

test("cookie helpers preserve ResMan cookie values for the mobile client and follow-up POST", () => {
  const setCookieHeaders = [
    "__RequestVerificationToken=csrf-cookie; path=/; secure; HttpOnly",
    ".AspNet.ApplicationCookie=session-cookie; path=/; secure; HttpOnly",
  ];

  assert.equal(
    buildCookieHeader(setCookieHeaders),
    "__RequestVerificationToken=csrf-cookie; .AspNet.ApplicationCookie=session-cookie"
  );

  assert.deepEqual(serializeCookiesForClient(setCookieHeaders), [
    {
      name: "__RequestVerificationToken",
      value: "csrf-cookie",
      domain: "multisouth.myresman.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
    {
      name: ".AspNet.ApplicationCookie",
      value: "session-cookie",
      domain: "multisouth.myresman.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
  ]);
});

test("isSuccessfulResmanLogin treats redirects away from SignIn as accepted credentials", () => {
  assert.equal(isSuccessfulResmanLogin(302, "/Portal/Home"), true);
  assert.equal(isSuccessfulResmanLogin(302, "/Portal/Access/SignIn/Emberly"), false);
  assert.equal(isSuccessfulResmanLogin(200, null), false);
});

test("resmanPortalLogin performs GET form discovery before POSTing credentials", async () => {
  const calls = [];
  const formHtml = `
    <form action="/Portal/Access/SignIn/Emberly" method="post">
      <input name="AccountID" type="hidden" value="1659" />
      <input name="PropertyName" type="hidden" value="Emberly Apartments" />
      <input name="ReturnUrl" type="hidden" value="" />
      <input name="PropertyID" type="hidden" value="489f05ba-6bd4-4888-9460-88923577a6eb" />
      <input name="ShowChangeLink" type="hidden" value="False" />
      <input name="__RequestVerificationToken" type="hidden" value="form-token" />
    </form>
  `;

  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });

    if (!init.method || init.method === "GET") {
      if (String(url).includes("/Portal/Home")) {
        return new Response(`
          <input id="LoggedInPersonName" name="LoggedInPersonName" type="hidden" value="Ben Bloch">
        `, { status: 200 });
      }

      return new Response(formHtml, {
        status: 200,
        headers: {
          "set-cookie": "__RequestVerificationToken=cookie-token; path=/; secure; HttpOnly",
        },
      });
    }

    const body = init.body;
    assert.equal(init.method, "POST");
    assert.equal(init.headers.cookie, "__RequestVerificationToken=cookie-token");
    assert.equal(body.get("Username"), "Bbloch01");
    assert.equal(body.get("Password"), "password");
    assert.equal(body.get("__RequestVerificationToken"), "form-token");

    return new Response("", {
      status: 302,
      headers: {
        location: "/Portal/Home",
        "set-cookie": ".AspNet.ApplicationCookie=session-cookie; path=/; secure; HttpOnly",
      },
    });
  };

  const result = await resmanPortalLogin("Bbloch01", "password", fetchImpl);

  assert.equal(result.success, true);
  assert.equal(calls.length, 3);
  assert.equal(result.tenantName, "Ben Bloch");
  assert.equal(
    result.session.cookieHeader,
    "__RequestVerificationToken=cookie-token; .AspNet.ApplicationCookie=session-cookie"
  );
});

test("parseResidentNameFromPortalHtml prefers the logged-in person field over impersonation headers", () => {
  assert.equal(
    parseResidentNameFromPortalHtml(`
      <div id="HeaderRight">
        <span>
          EMMUEAL HOUSTON
          <span class="hidden-xs-down">(Impersonated)</span>
        </span>
      </div>
      <input id="LoggedInPersonName" name="LoggedInPersonName" type="hidden" value="Ben Bloch">
    `),
    "Ben Bloch"
  );
});

test("parseTransactionsAccess extracts unit and allows current access statuses", () => {
  assert.deepEqual(
    parseTransactionsAccess(`
      <div id="HeaderRight">
        <span>
          EMMUEAL HOUSTON
          <span class="hidden-xs-down">(Impersonated)</span>
        </span>
      </div>
      <h3>Unit 1726 ST-4 (Under Eviction)</h3>
      <input id="UnitLeaseGroupID" name="UnitLeaseGroupID" type="hidden" value="eaf93329-91f0-4922-8074-18852a405d1c">
    `),
    {
      allowed: true,
      ledgerId: "eaf93329-91f0-4922-8074-18852a405d1c",
      tenantName: "EMMUEAL HOUSTON",
      unitNumber: "1726 ST-4",
      status: "Under Eviction",
    }
  );

  assert.equal(parseTransactionsAccess("<h3>Unit 100 (Current)</h3>").allowed, true);
  assert.equal(parseTransactionsAccess("<h3>Unit 100 (Pending Renewal)</h3>").allowed, true);
});

test("parseTransactionsAccess extracts resident name from the logged-in person field", () => {
  assert.deepEqual(
    parseTransactionsAccess(`
      <input id="LoggedInPersonName" name="LoggedInPersonName" type="hidden" value="Ben Bloch">
      <input id="UnitLeaseGroupID" name="UnitLeaseGroupID" type="hidden" value="lease-ledger-id">
      <h3>Unit 3644 DU-1 (Approved)</h3>
    `),
    {
      allowed: false,
      ledgerId: "lease-ledger-id",
      tenantName: "Ben Bloch",
      unitNumber: "3644 DU-1",
      status: "Approved",
    }
  );
});

test("parseTransactionsAccess denies pending, approved, former, and unknown statuses", () => {
  for (const status of ["Pending", "Approved", "Former", "Notice to Vacate"]) {
    const parsed = parseTransactionsAccess(`<h3>Unit 100 (${status})</h3>`);
    assert.equal(parsed.allowed, false);
    assert.equal(parsed.status, status);
  }
});

test("parseTransactionsAccess allows approved status only in development", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    process.env.NODE_ENV = "production";
    assert.equal(parseTransactionsAccess("<h3>Unit 100 (Approved)</h3>").allowed, false);

    process.env.NODE_ENV = "development";
    assert.deepEqual(parseTransactionsAccess("<h3>Unit 100 (Approved)</h3>"), {
      allowed: true,
      unitNumber: "100",
      status: "Approved",
    });
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
});

test("verifyResmanPortalAccess fetches the transactions page with the ResMan session cookie", async () => {
  const calls = [];
  const result = await verifyResmanPortalAccess(
    {
      baseUrl: "https://multisouth.myresman.com",
      signInUrl: "https://multisouth.myresman.com/Portal/Access/SignIn/Emberly",
      cookieHeader: "PortalAuthorizationCookie=session",
      cookies: [],
      issuedAt: "2026-06-20T12:00:00.000Z",
    },
    async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(
        `
          <h3>Unit 1726 ST-4 (Under Eviction)</h3>
          <input id="UnitLeaseGroupID" name="UnitLeaseGroupID" type="hidden" value="eaf93329-91f0-4922-8074-18852a405d1c">
        `,
        { status: 200 }
      );
    }
  );

  assert.deepEqual(result, {
    allowed: true,
    ledgerId: "eaf93329-91f0-4922-8074-18852a405d1c",
    unitNumber: "1726 ST-4",
    status: "Under Eviction",
  });
  assert.equal(calls[0].url, "https://multisouth.myresman.com/Portal/Transactions");
  assert.equal(calls[0].init.headers.cookie, "PortalAuthorizationCookie=session");
});
