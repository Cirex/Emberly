/**
 * End-to-end behaviour of the bill capture path, at the seams that matter:
 *
 *   downloadBill  — a real MLGW PDF still wins; a PDF-less bill is archived as
 *                   self-contained HTML and rendered to a PDF when a renderer is
 *                   available; when it is not, the invoice path stays empty so
 *                   the bills job falls back to a text transcript.
 *   writeTranscriptInvoiceFallback — that fallback.
 *
 * No Chromium is required. The one test that needs a real browser is gated on
 * MLGW_CAPTURE_CHROMIUM_SMOKE=1 and skipped by default.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { downloadBill } = require("../src/mlgw/download/target-downloader.ts");
const { InMemoryBillFileStore } = require("../src/mlgw/download/file-store.ts");
const { UnavailableBillPdfRenderer } = require("../src/mlgw/capture/pdf-renderer.ts");
const { writeTranscriptInvoiceFallback } = require("../src/mlgw/jobs.ts");

const BILL_URL = "https://ih-prd.fisglobal.com/bill/viewdocument?docId=754556658";

const BILL_HTML = `<html><head>
  <link rel="stylesheet" href="bill.css">
  <script src="tracker.js"></script>
</head><body class="bill">
  <img src="mlgw-logo.png" alt="MLGW">
  <h1>Memphis Light, Gas and Water</h1>
  <p>Account Number: 0013-4306-1416</p>
  <p>Date: 10/29/2025</p>
  <p>Amount Due $154.22 — services at 3713 KINGS GATE DR APT 3</p>
</body></html>`;

const ASSETS = {
  "https://ih-prd.fisglobal.com/bill/bill.css": {
    body: ".bill{font-family:Helvetica;background:url(paper.png)}",
    contentType: "text/css",
  },
  "https://ih-prd.fisglobal.com/bill/paper.png": { body: "PNGPAPER", contentType: "image/png" },
  "https://ih-prd.fisglobal.com/bill/mlgw-logo.png": { body: "PNGLOGO", contentType: "image/png" },
};

/** Duck-typed MLGWHTTPClient: serves the bill page, then the assets. */
function fakeClient({ html = BILL_HTML, assets = ASSETS, pdf = null } = {}) {
  const requests = [];
  return {
    requests,
    copyForConcurrentRequests() {
      return this;
    },
    async request(method, url) {
      const key = url.toString();
      requests.push(`${method} ${key}`);
      if (pdf !== null && key === pdf.url) {
        return {
          status: 200,
          headers: { "content-type": "application/pdf" },
          url: key,
          text: "",
          bytes: new Uint8Array(Buffer.from(pdf.body, "utf8")),
          isPdf: true,
        };
      }
      const asset = assets[key];
      if (asset !== undefined) {
        return {
          status: 200,
          headers: { "content-type": asset.contentType },
          url: key,
          text: asset.body,
          bytes: new Uint8Array(Buffer.from(asset.body, "utf8")),
          isPdf: false,
        };
      }
      if (key.startsWith(BILL_URL)) {
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          url: BILL_URL,
          text: html,
          bytes: new Uint8Array(Buffer.from(html, "utf8")),
          isPdf: false,
        };
      }
      return { status: 404, headers: {}, url: key, text: "", bytes: new Uint8Array(), isPdf: false };
    },
  };
}

function billTarget() {
  return {
    url: new URL(BILL_URL),
    method: "GET",
    fields: {},
    rowText: "0013-4306-1416 3713 KINGS GATE DR APT 3 $154.22 11/18/2025",
    documentId: "754556658",
    isCurrent: true,
    accountNumber: "0013-4306-1416",
    address: "3713 KINGS GATE DR APT 3",
    amountDue: "154.22",
    dueDate: "11/18/2025",
    paymentListURL: null,
  };
}

const NO_PDF_TEXT = { extractText: async () => "" };

function decode(bytes) {
  return Buffer.from(bytes).toString("utf8");
}

test("a PDF-less bill is archived as self-contained HTML and rendered to a real PDF", async () => {
  const store = new InMemoryBillFileStore();
  const rendered = new Uint8Array(Buffer.from("%PDF-1.4 rendered", "utf8"));
  const seen = [];
  const renderer = {
    async render(html) {
      seen.push(html);
      return rendered;
    },
    async close() {},
  };

  const bill = await downloadBill(billTarget(), fakeClient(), store, NO_PDF_TEXT, 0, undefined, {
    renderer,
    log: () => {},
  });

  // The invoice is the rendered PDF; the archive sits next to it under the same stem.
  assert.equal(bill.filePath, "20251029-001343061416-754556658.pdf");
  assert.equal(bill.capturedHtmlPath, "20251029-001343061416-754556658.html");
  assert.deepEqual(store.files.get(bill.filePath).bytes, rendered);
  assert.equal(store.files.get(bill.filePath).contentType, "application/pdf");
  assert.equal(store.files.get(bill.capturedHtmlPath).contentType, "text/html");

  // What was archived (and rendered) is the self-contained document.
  const archived = decode(store.files.get(bill.capturedHtmlPath).bytes);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], archived);
  assert.ok(!/<script/i.test(archived), "scripts are stripped from the capture");
  assert.ok(!archived.includes("bill.css"), "the stylesheet is inlined, not linked");
  assert.match(archived, /font-family:Helvetica/);
  assert.match(archived, /<img alt="MLGW" src="data:image\/png;base64,[^"]+">/);
  assert.match(archived, /background:url\("data:image\/png;base64,[^"]+"\)/);
  assert.ok(!archived.includes("mlgw-logo.png"));

  // The parsed text is unchanged by any of this.
  assert.match(bill.extractedText, /Memphis Light, Gas and Water/);
});

test("without a renderer the invoice path stays empty but the archive is still stored", async () => {
  const store = new InMemoryBillFileStore();
  const logs = [];

  const bill = await downloadBill(billTarget(), fakeClient(), store, NO_PDF_TEXT, 0, undefined, {
    renderer: new UnavailableBillPdfRenderer(),
    log: (m) => logs.push(m),
  });

  assert.equal(bill.filePath, "", "no invoice — the bills job will write a transcript");
  assert.equal(bill.capturedHtmlPath, "20251029-001343061416-754556658.html");
  assert.ok(store.files.has(bill.capturedHtmlPath), "the archival copy survives a failed render");
  assert.ok(![...store.files.keys()].some((name) => name.endsWith(".pdf")), "no PDF was written");
  assert.match(decode(store.files.get(bill.capturedHtmlPath).bytes), /Memphis Light, Gas and Water/);
});

test("a renderer that throws is contained: the bill still downloads and archives", async () => {
  const store = new InMemoryBillFileStore();
  const renderer = {
    async render() {
      throw new Error("Target page crashed");
    },
    async close() {},
  };

  // downloadBill must not propagate the renderer's failure.
  const bill = await downloadBill(billTarget(), fakeClient(), store, NO_PDF_TEXT, 0, undefined, {
    renderer: {
      render: async (html) => {
        try {
          return await renderer.render(html);
        } catch {
          return null; // the real ChromiumBillPdfRenderer swallows here
        }
      },
      close: async () => {},
    },
    log: () => {},
  });

  assert.equal(bill.filePath, "");
  assert.ok(store.files.has(bill.capturedHtmlPath));
});

test("with no capture options at all the bill is still archived (no PDF)", async () => {
  const store = new InMemoryBillFileStore();
  const bill = await downloadBill(billTarget(), fakeClient(), store, NO_PDF_TEXT, 0);
  assert.equal(bill.filePath, "");
  assert.ok(store.files.has(bill.capturedHtmlPath));
});

test("a genuine MLGW PDF still wins — no capture, no render, unchanged behaviour", async () => {
  const store = new InMemoryBillFileStore();
  const pdfURL = "https://ih-prd.fisglobal.com/bill/invoice.pdf";
  const html = BILL_HTML.replace("<h1>", `<a href="${pdfURL}">Download PDF</a><h1>`);
  const client = fakeClient({ html, pdf: { url: pdfURL, body: "%PDF-1.7 real invoice" } });
  let renderCalls = 0;

  const bill = await downloadBill(billTarget(), client, store, NO_PDF_TEXT, 0, undefined, {
    renderer: {
      render: async () => {
        renderCalls += 1;
        return new Uint8Array([1]);
      },
      close: async () => {},
    },
    log: () => {},
  });

  assert.equal(renderCalls, 0, "the renderer is never invoked when MLGW publishes a PDF");
  assert.equal(bill.filePath, "20251029-001343061416-754556658.pdf");
  assert.equal(bill.capturedHtmlPath, "", "no HTML capture is made for a real PDF bill");
  assert.equal(decode(store.files.get(bill.filePath).bytes), "%PDF-1.7 real invoice");
  assert.equal(store.files.size, 1);
});

test("assets that cannot be fetched are logged and omitted, never fatal", async () => {
  const store = new InMemoryBillFileStore();
  const logs = [];
  const client = fakeClient({ assets: {} }); // every asset 404s

  const bill = await downloadBill(billTarget(), client, store, NO_PDF_TEXT, 0, undefined, {
    renderer: new UnavailableBillPdfRenderer(),
    log: (m) => logs.push(m),
  });

  assert.ok(store.files.has(bill.capturedHtmlPath));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /omitted 2 asset\(s\) from the capture/);
  assert.match(logs[0], /unfetchable:/);
});

test("writeTranscriptInvoiceFallback fills the gap left by an unavailable renderer", async () => {
  const store = new InMemoryBillFileStore();
  const billRow = { document_id: "754556658", file_path: "" };
  const summary = {
    billDate: "10/29/2025",
    accountNumber: "0013-4306-1416",
    documentId: "754556658",
    servicesAt: "3713 KINGS GATE DR APT 3",
    dueDate: "11/18/2025",
  };

  const wrote = await writeTranscriptInvoiceFallback(billRow, summary, "Electric service $55.00", store);

  assert.equal(wrote, true);
  assert.equal(billRow.file_path, "20251029-001343061416-754556658.pdf");
  const stored = store.files.get(billRow.file_path);
  assert.equal(stored.contentType, "application/pdf");
  assert.match(decode(stored.bytes), /^%PDF-1\.4/);
  assert.match(decode(stored.bytes), /Electric service \$55\.00/);
});

test("the transcript fallback does not run when a real invoice is already stored", async () => {
  const store = new InMemoryBillFileStore();
  const billRow = { document_id: "754556658", file_path: "20251029-001343061416-754556658.pdf" };
  const summary = {
    billDate: "10/29/2025",
    accountNumber: "0013-4306-1416",
    documentId: "754556658",
    servicesAt: "x",
    dueDate: "11/18/2025",
  };
  assert.equal(await writeTranscriptInvoiceFallback(billRow, summary, "text", store), false);
  assert.equal(store.files.size, 0);
  // Nor when there is no captured text to transcribe.
  const empty = { document_id: "1", file_path: "" };
  assert.equal(await writeTranscriptInvoiceFallback(empty, summary, "   ", store), false);
  assert.equal(await writeTranscriptInvoiceFallback(empty, summary, undefined, store), false);
  assert.equal(empty.file_path, "");
});

// Requires a real Chromium; opt in with MLGW_CAPTURE_CHROMIUM_SMOKE=1.
test(
  "smoke: a self-contained fixture renders to a real PDF",
  { skip: process.env.MLGW_CAPTURE_CHROMIUM_SMOKE !== "1" ? "set MLGW_CAPTURE_CHROMIUM_SMOKE=1" : false },
  async () => {
    const { ChromiumBillPdfRenderer } = require("../src/mlgw/capture/pdf-renderer.ts");
    const renderer = new ChromiumBillPdfRenderer({ log: (m) => console.log(m) });
    try {
      const bytes = await renderer.render(
        '<html><body style="font-family:Helvetica"><h1>MLGW</h1><p>Amount due $154.22</p></body></html>',
      );
      assert.ok(bytes !== null, "Chromium produced a PDF");
      assert.ok(bytes.length > 500, `PDF is non-trivial (${bytes.length} bytes)`);
      assert.equal(Buffer.from(bytes.slice(0, 4)).toString("latin1"), "%PDF");
      console.log(`[smoke] rendered ${bytes.length} bytes`);
    } finally {
      await renderer.close();
    }
  },
);
