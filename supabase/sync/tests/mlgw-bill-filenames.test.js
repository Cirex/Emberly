const assert = require("node:assert/strict");
const test = require("node:test");

const {
  billCaptureFilenames,
  billFilenameStem,
  desiredBillFilename,
} = require("../src/mlgw/download/filenames.ts");

test("the html variant shares the pdf's stem", () => {
  const names = billCaptureFilenames("10/29/2025", "00136-4306-1416-817", "754556658", "fallback");
  assert.deepEqual(names, {
    pdf: "20251029-0013643061416817-754556658.pdf",
    html: "20251029-0013643061416817-754556658.html",
  });
  assert.equal(names.pdf.replace(/\.pdf$/, ""), names.html.replace(/\.html$/, ""));
});

test("desiredBillFilename still produces the historical names", () => {
  assert.equal(desiredBillFilename("10/29/2025", "0013-857", "9556", "pdf"), "20251029-0013857-9556.pdf");
  assert.equal(desiredBillFilename("October 29, 2025", "0013857", null, "pdf"), "20251029-0013857.pdf");
  assert.equal(desiredBillFilename("", "0013857", "9556", "pdf"), null);
  assert.equal(desiredBillFilename("10/29/2025", "", "9556", "pdf"), null);
});

test("desiredBillFilename and billCaptureFilenames agree on the pdf name", () => {
  const cases = [
    ["10/29/2025", "0013857", "9556"],
    ["October 29, 2025", "0013-857", null],
    ["3/7/25", "42", undefined],
  ];
  for (const [date, account, document] of cases) {
    assert.equal(
      billCaptureFilenames(date, account, document, "unused").pdf,
      desiredBillFilename(date, account, document, "pdf"),
    );
  }
});

test("a bill with no usable date/account falls back to the caller's stem, still paired", () => {
  const names = billCaptureFilenames("", "", null, "mlgw-bill-7");
  assert.deepEqual(names, { pdf: "mlgw-bill-7.pdf", html: "mlgw-bill-7.html" });
  assert.equal(billFilenameStem("", "", null), null);
});
