const assert = require("node:assert/strict");
const test = require("node:test");

const { billTextPdf } = require("../src/mlgw/parse/text-pdf.ts");

function decode(bytes) {
  return Buffer.from(bytes).toString("latin1");
}

const OPTIONS = {
  title: "MLGW Bill - Account 00136-4306-1416-817",
  facts: ["Service at 3713 KINGS GATE DR APT 3", "Bill date Oct 29, 2025 - Document #754556658"],
  text: "Electric service\n  Energy charge    $55.00\nWater service\n  Usage            $22.83",
};

test("renders a structurally valid single-page PDF carrying the bill text", () => {
  const bytes = billTextPdf(OPTIONS);
  const pdf = decode(bytes);
  assert.match(pdf, /^%PDF-1\.4\n/);
  assert.match(pdf, /%%EOF\n$/);
  assert.match(pdf, /\/Count 1 >>/);
  assert.match(pdf, /Courier/);
  assert.match(pdf, /\(MLGW Bill - Account 00136-4306-1416-817\) Tj/);
  assert.match(pdf, /\(  Energy charge    \$55\.00\) Tj/);
  assert.match(pdf, /Text capture of the MLGW portal bill page/);
  // xref offset in the trailer points at the actual xref table.
  const xrefAt = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.equal(pdf.slice(xrefAt, xrefAt + 4), "xref");
});

test("escapes PDF delimiters and paginates long bills", () => {
  const bytes = billTextPdf({
    title: "T (test) \\ done",
    facts: [],
    text: Array.from({ length: 200 }, (_, i) => `line (${i}) \\`).join("\n"),
  });
  const pdf = decode(bytes);
  assert.match(pdf, /\(T \\\(test\\\) \\\\ done\) Tj/);
  assert.match(pdf, /\/Count 4 >>/); // 61 on the header page, then 65/page
  // Every object the xref advertises exists.
  const size = Number(pdf.match(/\/Size (\d+)/)[1]);
  for (let i = 1; i < size; i += 1) assert.ok(pdf.includes(`${i} 0 obj`), `object ${i} present`);
});

test("hard-wraps lines wider than the Courier column count", () => {
  const wide = "X".repeat(300);
  const pdf = decode(billTextPdf({ title: "t", facts: [], text: wide }));
  assert.ok(!/\(X{99}/.test(pdf), "no line renders wider than the column budget");
});
