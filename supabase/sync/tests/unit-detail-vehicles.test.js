const assert = require("node:assert/strict");
const test = require("node:test");

const { splitLicensePlate, parseVehiclesTab } = require("../src/resman/scrapers/unit-detail");

// MARK: - splitLicensePlate
//
// ResMan packs plate and state into one "PLATE/ST" cell. The register is typed
// by hand, so the cell is also where "N/A" lands — 42 of 895 rows, each of which
// used to become the plate "N" with the state "A".

test("splits a real plate/state cell", () => {
  assert.deepEqual(splitLicensePlate("BJL0536/TN"), { plate: "BJL0536", state: "TN" });
  assert.deepEqual(splitLicensePlate(" BJL0536 / tn "), { plate: "BJL0536", state: "tn" });
});

test("N/A is not a plate", () => {
  for (const raw of ["N/A", "n/a", " N/A ", "NA", "na", "none", "unknown", "-", "--", ""]) {
    assert.deepEqual(splitLicensePlate(raw), { plate: "", state: "" }, `for ${JSON.stringify(raw)}`);
  }
});

test("a lone plate with no state survives", () => {
  assert.deepEqual(splitLicensePlate("BJL0536"), { plate: "BJL0536", state: "" });
  assert.deepEqual(splitLicensePlate("9316"), { plate: "9316", state: "" }, "partial plates are kept");
});

test("a slash inside a plate is not a state boundary", () => {
  // Only a two-letter tail is a state; anything else belongs to the plate.
  assert.deepEqual(splitLicensePlate("AB/12345"), { plate: "AB/12345", state: "" });
  assert.deepEqual(splitLicensePlate("TEMP/2026"), { plate: "TEMP/2026", state: "" });
});

// MARK: - parseVehiclesTab

const ROW = (makeModel, year, color, plate) => `
  <tr>
    <td class="a-year-col"><span class="field-value">${year}</span></td>
    <td class="a-make-model-col"><span class="field-value">${makeModel}</span></td>
    <td class="a-color-col"><span class="field-value">${color}</span></td>
    <td class="a-license-plate-col"><span class="field-value">${plate}</span></td>
  </tr>`;

test("normalizes the casing the register arrives in", () => {
  const [a, b, c] = parseVehiclesTab(
    ROW("HONDA ACCORD SPORT", "2017", "RED", "BJL0536/TN") +
      ROW("chevy malibu", "2008", "tan/ gold", "ABC1234/tn") +
      ROW("Nissan Maxima", "2011", "Black", "9316/TN"),
  );

  assert.equal(a.Make, "Honda");
  assert.equal(a.Model, "Accord Sport");
  assert.equal(a.Color, "Red");

  assert.equal(b.Make, "Chevy");
  assert.equal(b.Model, "Malibu");
  assert.equal(b.Color, "Tan/Gold", "spacing around the slash is tidied too");

  assert.equal(c.Make, "Nissan", "already correct, unchanged");
});

test("marque acronyms are not title-cased into nonsense", () => {
  const [gmc, bmw] = parseVehiclesTab(ROW("GMC SIERRA", "2019", "WHITE", "X/TN") + ROW("BMW 328I", "2015", "BLACK", "Y/TN"));
  assert.equal(gmc.Make, "GMC");
  assert.equal(bmw.Make, "BMW");
});

test("plates are upper-cased and N/A rows carry no plate", () => {
  const [good, na] = parseVehiclesTab(
    ROW("Ford Mustang", "2018", "blue", "bjl0536/tn") + ROW("ford mustang", "2018", "blue", "N/A"),
  );
  assert.equal(good["License Plate"], "BJL0536");
  assert.equal(good.State, "TN");
  // `assignText` omits blanks — an absent key is this parser's "not recorded",
  // which the mappers' pick() and the column default already understand.
  assert.ok(!("License Plate" in na), "the N/A row must not claim the plate 'N'");
  assert.ok(!("State" in na), "…nor the state 'A'");
});
