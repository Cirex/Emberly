const assert = require("node:assert/strict");
const test = require("node:test");

const { htmlToText } = require("../src/mlgw/text");

// Regression: the <script>/<style> strips ran without the dotAll flag, so `.*?`
// stopped at the first newline and any multi-line block survived. Its CSS/JS
// text then flowed into the bill parser's input and into the captured
// transcript PDF, which is why captures were full of stylesheet noise.

test("strips a multi-line <style> block", () => {
  const html = "<style>\n.a { color: red; }\n.b { color: blue; }\n</style><p>Amount due 212.40</p>";
  const text = htmlToText(html);
  assert.equal(text.includes("color: red"), false);
  assert.equal(text.includes("Amount due 212.40"), true);
});

test("strips a multi-line <script> block", () => {
  const html = "<script>\nvar total = 212.40;\nwindow.x = 1;\n</script><p>Total 212.40</p>";
  const text = htmlToText(html);
  assert.equal(text.includes("window.x"), false);
  assert.equal(text.includes("Total 212.40"), true);
});

test("strips <style> carrying attributes", () => {
  const html = '<style type="text/css" media="print">\n@page { margin: 0; }\n</style><p>Due Jul 28</p>';
  const text = htmlToText(html);
  assert.equal(text.includes("@page"), false);
  assert.equal(text.includes("Due Jul 28"), true);
});

test("keeps table cell text across a realistic charge row", () => {
  const html =
    "<style>\ntd { padding: 4px; }\n</style>" +
    "<table><tr><td>Electric</td><td>1,184 kWh</td><td>$131.06</td></tr></table>";
  const text = htmlToText(html);
  assert.equal(text.includes("padding"), false);
  assert.equal(text.includes("Electric"), true);
  assert.equal(text.includes("$131.06"), true);
});
