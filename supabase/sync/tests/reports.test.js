
const assert = require("node:assert/strict");
const test = require("node:test");

const { ResManReportFormBuilder, ResManReportService } = require("../src/resman/report-service");

const PAGE_CONTEXT = { html: "", csrfToken: "csrf-tok", dxCss: "a.css,dxr-1" };

const ENDPOINT = {
  viewerUrl: "https://multisouth.myresman.com/Reports/UnitInfo",
  exportUrl: "https://multisouth.myresman.com/Reports/GetUnitInfoReport",
  errorDomain: "ResManUnitInfo",
  logName: "unit-info",
};

// MARK: - ResManReportFormBuilder (field ordering + DevExpress conventions)

test("form builder seeds the required DevExpress fields in order", () => {
  const builder = new ResManReportFormBuilder(PAGE_CONTEXT, "UnitInfo", "prop-1");
  assert.deepEqual(builder.fields, [
    ["__RequestVerificationToken", "csrf-tok"],
    ["DisplayableReportName", "UnitInfo"],
    ["SetupRouteValues", "True"],
    ["PropertyOrGroupParameter.PropertyOrGroupIDs", "prop-1"],
  ]);
});

test("appendCheckbox uses the ASP.NET true-then-false convention", () => {
  const checked = new ResManReportFormBuilder(PAGE_CONTEXT, "R", "p");
  checked.appendCheckbox("Parameters.Flag", true);
  assert.deepEqual(checked.fields.slice(4), [
    ["Parameters.Flag", "true"],
    ["Parameters.Flag", "false"],
  ]);

  const unchecked = new ResManReportFormBuilder(PAGE_CONTEXT, "R", "p");
  unchecked.appendCheckbox("Parameters.Flag", false);
  assert.deepEqual(unchecked.fields.slice(4), [["Parameters.Flag", "false"]]);
});

test("appendRepeated adds one entry per value (report multi-select params)", () => {
  const builder = new ResManReportFormBuilder(PAGE_CONTEXT, "R", "p");
  builder.appendRepeated("Parameters.Statuses", ["Current", "Pending"]);
  assert.deepEqual(builder.fields.slice(4), [
    ["Parameters.Statuses", "Current"],
    ["Parameters.Statuses", "Pending"],
  ]);
});

test("finish appends DXCss / ExportType / Export=True at the tail", () => {
  const builder = new ResManReportFormBuilder(PAGE_CONTEXT, "UnitInfo", "prop-1");
  builder.append("Parameters.ReportName", "UnitInfo");
  const fields = builder.finish("Source Data (CSV) w/ IDs");
  assert.deepEqual(fields.slice(-3), [
    ["DXCss", "a.css,dxr-1"],
    ["ExportType", "Source Data (CSV) w/ IDs"],
    ["Export", "True"],
  ]);
  // Seeded fields still lead, custom field kept in the middle.
  assert.deepEqual(fields[0], ["__RequestVerificationToken", "csrf-tok"]);
  assert.deepEqual(fields[4], ["Parameters.ReportName", "UnitInfo"]);
});

// MARK: - ResManReportService

function makeResponse(overrides) {
  return {
    status: 200,
    finalUrl: ENDPOINT.exportUrl,
    contentType: "text/csv",
    headers: new Headers(),
    bytes: new Uint8Array(),
    text: "",
    ...overrides,
  };
}

test("loadViewerContext extracts the CSRF token and DXCss from the viewer", async () => {
  const viewerHtml = `
    <input name="__RequestVerificationToken" value="viewer-tok" />
    <link rel="stylesheet" href="/bundles/DXWebResources.css" />
    <script src="/DXR.axd?r=res9"></script>`;
  const service = new ResManReportService({
    requestData: async () => makeResponse({ text: viewerHtml, contentType: "text/html" }),
    userAgent: "test-agent",
  });
  const ctx = await service.loadViewerContext(ENDPOINT);
  assert.equal(ctx.csrfToken, "viewer-tok");
  assert.ok(ctx.dxCss.includes("/bundles/DXWebResources.css"));
  assert.ok(ctx.dxCss.includes("res9"));
});

test("exportCSV returns bytes for a genuine CSV response", async () => {
  const csv = new TextEncoder().encode("UnitID,Unit\nunit-1,101");
  const service = new ResManReportService({
    requestData: async () => makeResponse({ contentType: "text/csv", bytes: csv, text: "UnitID,Unit\nunit-1,101" }),
    userAgent: "test-agent",
  });
  const bytes = await service.exportCSV(ENDPOINT, [["Export", "True"]]);
  assert.deepEqual(Array.from(bytes), Array.from(csv));
});

test("exportCSV rejects an HTML error page (ResMan's failure mode)", async () => {
  const service = new ResManReportService({
    requestData: async () =>
      makeResponse({ contentType: "text/html; charset=utf-8", text: "<html>error</html>" }),
    userAgent: "test-agent",
  });
  await assert.rejects(service.exportCSV(ENDPOINT, [["Export", "True"]]), /HTML, not CSV/);
});

test("exportCSV rejects a non-200 response", async () => {
  const service = new ResManReportService({
    requestData: async () => makeResponse({ status: 500, contentType: "text/csv", text: "oops" }),
    userAgent: "test-agent",
  });
  await assert.rejects(service.exportCSV(ENDPOINT, [["Export", "True"]]));
});
