const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSelfContainedDocument,
  describeSkippedAssets,
  resolveAssetURL,
  stripExecutableContent,
} = require("../src/mlgw/capture/html-inliner.ts");

const BASE = "https://ih-prd.fisglobal.com/bill/viewdocument/page.jsp?doc=123";

/** An AssetFetch backed by a { url -> {body, contentType} } map; records every request. */
function fakeFetcher(assets, requested = []) {
  return async (url) => {
    requested.push(url);
    const asset = assets[url];
    if (asset === undefined) return null;
    const bytes = typeof asset.body === "string" ? Buffer.from(asset.body, "utf8") : asset.body;
    return { bytes: new Uint8Array(bytes), contentType: asset.contentType ?? "" };
  };
}

test("resolves relative, root-relative, and absolute asset URLs against the page", async () => {
  const requested = [];
  const assets = {
    "https://ih-prd.fisglobal.com/bill/viewdocument/logo.png": { body: "PNG", contentType: "image/png" },
    "https://ih-prd.fisglobal.com/assets/bill.css": { body: "body{color:red}", contentType: "text/css" },
    "https://cdn.example.com/seal.gif": { body: "GIF", contentType: "image/gif" },
  };
  const html = `<html><head><link rel="stylesheet" href="/assets/bill.css"></head>
    <body><img src="logo.png"><img src="https://cdn.example.com/seal.gif"></body></html>`;

  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher(assets, requested));

  assert.deepEqual(requested.sort(), Object.keys(assets).sort());
  assert.equal(doc.inlinedAssets, 3);
  assert.equal(doc.skipped.length, 0);
  // The stylesheet became an inline <style> block, not a link.
  assert.ok(!/<link\b/i.test(doc.html), "no <link> elements survive");
  assert.match(doc.html, /<style>\s*body\{color:red\}\s*<\/style>/);
  // Both images are data URIs, and nothing external remains.
  assert.match(doc.html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  assert.match(doc.html, /<img src="data:image\/gif;base64,[A-Za-z0-9+/=]+"/);
  assert.ok(!doc.html.includes("cdn.example.com"), "no external URL remains in the document");
  assert.ok(!doc.html.includes("/assets/bill.css"));
});

test("honors <base href> when resolving, then drops the element", async () => {
  const requested = [];
  const assets = {
    "https://ih-prd.fisglobal.com/other/logo.png": { body: "PNG", contentType: "image/png" },
  };
  const html = `<html><head><base href="https://ih-prd.fisglobal.com/other/"></head><body><img src="logo.png"></body></html>`;

  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher(assets, requested));

  assert.deepEqual(requested, ["https://ih-prd.fisglobal.com/other/logo.png"]);
  assert.ok(!/<base\b/i.test(doc.html), "<base> is removed from the archive");
});

test("an unfetchable asset degrades to an inert reference instead of failing", async () => {
  const html = `<html><body><img src="missing.png"><link rel="stylesheet" href="gone.css"></body></html>`;

  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher({}));

  assert.equal(doc.inlinedAssets, 0);
  assert.equal(doc.skipped.length, 2);
  assert.ok(doc.skipped.every((entry) => entry.reason === "unfetchable"));
  // The reference is neutralized, never left pointing at the network.
  assert.match(doc.html, /<img src="data:,"/);
  assert.ok(!doc.html.includes("missing.png"));
  assert.ok(!doc.html.includes("gone.css"));
});

test("a fetcher that throws is treated as an unfetchable asset", async () => {
  const html = `<body><img src="boom.png"></body>`;
  const doc = await buildSelfContainedDocument(html, BASE, async () => {
    throw new Error("socket hang up");
  });
  assert.equal(doc.skipped.length, 1);
  assert.equal(doc.skipped[0].reason, "unfetchable");
  assert.match(doc.html, /<img src="data:,"/);
});

test("<script> elements, inline handlers, and javascript: URLs are stripped", async () => {
  const html = `<html><head><script src="app.js"></script><script>alert(1)</script></head>
    <body onload="steal()"><a href="javascript:void(0)" onclick="go()">Pay</a>
    <p>The word onclick= appears in the bill text</p></body></html>`;

  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher({}));

  assert.ok(!/<script/i.test(doc.html), "no script elements");
  assert.ok(!doc.html.includes("alert(1)"));
  assert.ok(!doc.html.includes("onload="), "no inline event handlers");
  assert.ok(!doc.html.includes("onclick=\""), "no inline click handlers");
  assert.ok(!doc.html.includes("javascript:"), "no javascript: URLs");
  // Page text that merely mentions a handler is left alone.
  assert.match(doc.html, /The word onclick= appears in the bill text/);
});

test("an unterminated <script> tail cannot smuggle code through", async () => {
  const doc = await buildSelfContainedDocument("<body>x<script>while(1){}", BASE, fakeFetcher({}));
  assert.ok(!/<script/i.test(doc.html));
  assert.ok(!doc.html.includes("while(1)"));
});

test("assets larger than the per-asset cap are skipped and reported", async () => {
  const assets = {
    "https://ih-prd.fisglobal.com/bill/viewdocument/huge.png": {
      body: Buffer.alloc(2048),
      contentType: "image/png",
    },
    "https://ih-prd.fisglobal.com/bill/viewdocument/small.png": {
      body: Buffer.alloc(16),
      contentType: "image/png",
    },
  };
  const html = `<body><img src="huge.png"><img src="small.png"></body>`;

  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher(assets), { maxAssetBytes: 1024 });

  assert.equal(doc.inlinedAssets, 1);
  assert.equal(doc.skipped.length, 1);
  assert.equal(doc.skipped[0].reason, "oversize");
  assert.equal(doc.skipped[0].bytes, 2048);
  assert.match(doc.skipped[0].url, /huge\.png$/);
  assert.match(describeSkippedAssets(doc.skipped), /^oversize:.*huge\.png \(2048B\)$/);
});

test("the whole-document budget stops inlining rather than blowing up memory", async () => {
  const assets = {
    "https://ih-prd.fisglobal.com/bill/viewdocument/a.png": { body: Buffer.alloc(600), contentType: "image/png" },
    "https://ih-prd.fisglobal.com/bill/viewdocument/b.png": { body: Buffer.alloc(600), contentType: "image/png" },
    "https://ih-prd.fisglobal.com/bill/viewdocument/c.png": { body: Buffer.alloc(600), contentType: "image/png" },
  };
  const html = `<body><img src="a.png"><img src="b.png"><img src="c.png"></body>`;

  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher(assets), { maxDocumentBytes: 1000 });

  assert.equal(doc.inlinedAssets, 1);
  assert.equal(doc.inlinedBytes, 600);
  assert.equal(doc.skipped.filter((entry) => entry.reason === "budget").length, 2);
});

test("stylesheet url() and @import are followed and inlined", async () => {
  const assets = {
    "https://ih-prd.fisglobal.com/bill/viewdocument/bill.css": {
      body: '@import url("fonts.css");\n.logo{background:url(logo.png)}',
      contentType: "text/css",
    },
    "https://ih-prd.fisglobal.com/bill/viewdocument/fonts.css": {
      body: "@font-face{font-family:B;src:url('b.woff2') format('woff2')}",
      contentType: "text/css",
    },
    "https://ih-prd.fisglobal.com/bill/viewdocument/logo.png": { body: "PNG", contentType: "image/png" },
    "https://ih-prd.fisglobal.com/bill/viewdocument/b.woff2": { body: "FONT", contentType: "font/woff2" },
  };
  const html = `<head><link rel="stylesheet" href="bill.css"></head><body></body>`;

  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher(assets));

  assert.equal(doc.inlinedAssets, 4);
  assert.ok(!doc.html.includes("@import"), "the imported sheet is spliced in, not referenced");
  assert.match(doc.html, /url\("data:image\/png;base64,[^"]+"\)/);
  assert.match(doc.html, /url\("data:font\/woff2;base64,[^"]+"\)/);
});

test("inline <style> blocks and style attributes are inlined too", async () => {
  const assets = {
    "https://ih-prd.fisglobal.com/bill/viewdocument/bg.png": { body: "PNG", contentType: "image/png" },
  };
  const html = `<head><style type="text/css">.a{background:url(bg.png)}</style></head>` +
    `<body><div style="background-image:url(bg.png)">x</div></body>`;

  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher(assets));

  assert.match(doc.html, /<style type="text\/css">\.a\{background:url\("data:image\/png;base64,[^"]+"\)\}<\/style>/);
  assert.match(doc.html, /style="background-image:url\(&quot;data:image\/png;base64,[^"]+&quot;\)"/);
});

test("data: URIs already in the document are left untouched and never fetched", async () => {
  const requested = [];
  const html = `<body><img src="data:image/gif;base64,R0lGOD"><div style="background:url(data:image/gif;base64,R0lGOD)"></div></body>`;
  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher({}, requested));
  assert.deepEqual(requested, []);
  assert.match(doc.html, /<img src="data:image\/gif;base64,R0lGOD"/);
  assert.equal(doc.skipped.length, 0);
});

test("the same asset referenced twice is fetched once", async () => {
  const requested = [];
  const assets = {
    "https://ih-prd.fisglobal.com/bill/viewdocument/logo.png": { body: "PNG", contentType: "image/png" },
  };
  const html = `<body><img src="logo.png"><img src="./logo.png"></body>`;
  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher(assets, requested));
  assert.equal(requested.length, 1);
  assert.equal(doc.inlinedAssets, 1);
});

test("srcset is dropped so the inlined src is authoritative", async () => {
  const assets = {
    "https://ih-prd.fisglobal.com/bill/viewdocument/logo.png": { body: "PNG", contentType: "image/png" },
  };
  const html = `<body><img src="logo.png" srcset="logo@2x.png 2x, logo@3x.png 3x" alt="MLGW"></body>`;
  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher(assets));
  assert.ok(!doc.html.includes("srcset"));
  assert.ok(!doc.html.includes("logo@2x.png"));
  assert.match(doc.html, /alt="MLGW"/);
});

test("iframed bill content is inlined as srcdoc; unreachable frames are removed", async () => {
  const assets = {
    "https://ih-prd.fisglobal.com/bill/viewdocument/inner.html": {
      body: '<html><body><img src="seal.png"><script>bad()</script></body></html>',
      contentType: "text/html",
    },
    "https://ih-prd.fisglobal.com/bill/viewdocument/seal.png": { body: "PNG", contentType: "image/png" },
  };
  const html = `<body><iframe src="inner.html"></iframe><iframe src="nope.html"></iframe></body>`;

  const doc = await buildSelfContainedDocument(html, BASE, fakeFetcher(assets));

  assert.match(doc.html, /<iframe srcdoc="/);
  assert.ok(doc.html.includes("data:image/png;base64"), "the frame's own assets are inlined");
  assert.ok(!doc.html.includes("bad()"), "scripts inside the frame are stripped too");
  assert.ok(!doc.html.includes("nope.html"), "an unreachable frame is dropped entirely");
  assert.equal(doc.html.match(/<iframe/g).length, 1);
});

test("a UTF-8 charset declaration is added so the archive decodes off-line", async () => {
  const doc = await buildSelfContainedDocument("<html><head><title>Bill</title></head><body>é</body></html>", BASE, fakeFetcher({}));
  assert.match(doc.html, /<head><meta charset="utf-8">/);
  const already = await buildSelfContainedDocument(
    '<html><head><meta charset="ISO-8859-1"></head><body>x</body></html>',
    BASE,
    fakeFetcher({}),
  );
  assert.equal(already.html.match(/charset/gi).length, 1, "an existing declaration is respected");
});

test("resolveAssetURL only accepts fetchable http(s) references", () => {
  const base = new URL(BASE);
  assert.equal(resolveAssetURL("a.png", base).toString(), "https://ih-prd.fisglobal.com/bill/viewdocument/a.png");
  assert.equal(resolveAssetURL("//cdn.example.com/a.png", base).toString(), "https://cdn.example.com/a.png");
  for (const raw of ["", "   ", "#anchor", "data:image/gif;base64,AA", "javascript:x()", "mailto:a@b.c", "about:blank"]) {
    assert.equal(resolveAssetURL(raw, base), null, `${JSON.stringify(raw)} is not fetchable`);
  }
  assert.equal(resolveAssetURL(null, base), null);
});

test("stripExecutableContent is idempotent", () => {
  const once = stripExecutableContent('<p onclick="x()">hi</p><script>y()</script>');
  assert.equal(stripExecutableContent(once), once);
  assert.equal(once, "<p>hi</p>");
});
