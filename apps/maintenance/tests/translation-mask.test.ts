import { describe, expect, test } from "bun:test";
import { mask, sentinelsIntact, unmask } from "@/lib/translation/mask";

/** A round-trip that never touches the tokens leaves the source unchanged. */
function roundTrip(text: string): string {
  const { masked, tokens } = mask(text);
  return unmask(masked, tokens);
}

describe("mask / unmask", () => {
  test("round-trips to the original when the masked text is untouched", () => {
    const samples = [
      "Water heater leaking from T&P valve",
      "Tenant reports water pooling under the 40-gal heater. T&P dripping; needs replacement.",
      "Replaced T&P valve, flushed tank. Recommend full HWH swap at next PM — anode rod spent.",
      "GFCI in unit 1710 CW-3 tripping. Breaker is 15A.",
      "",
    ];
    for (const s of samples) expect(roundTrip(s)).toBe(s);
  });

  test("protects abbreviations, measurements, money, codes, and unit shorthand", () => {
    const { masked, tokens } = mask(
      "Swap 40-gal HWH ($1,240), check 3/4\" line at 220v in 1710 CW-3, part RH2040.",
    );
    // The prose words remain; the protected spans are gone from the masked text.
    expect(masked).toContain("Swap");
    expect(masked).toContain("check");
    expect(masked).toContain("line at");
    for (const t of ["40-gal", "HWH", "$1,240", '3/4"', "220v", "1710 CW-3", "RH2040"]) {
      expect(tokens).toContain(t);
      expect(masked).not.toContain(t);
    }
  });

  test("leaves bare prose numbers alone so sentences don't fragment", () => {
    const { masked, tokens } = mask("Tenant called 3 times about the leak; 2nd visit today.");
    expect(masked).toBe("Tenant called 3 times about the leak; 2nd visit today.");
    expect(tokens).toHaveLength(0);
  });

  test("percentages and dimensions are protected", () => {
    const a = mask("Humidity at 85% in the crawlspace");
    expect(a.tokens).toContain("85%");
    const b = mask("Cut a 12x8 access panel");
    expect(b.tokens).toContain("12x8");
  });

  test("sentinels survive and are detectable for the integrity check", () => {
    const { masked, tokens } = mask("Bleed the T&P at 40-gal HWH");
    expect(sentinelsIntact(masked, tokens.length)).toBe(true);
    // A translator that drops a placeholder fails the check.
    expect(sentinelsIntact(masked.replace("⟦0⟧", ""), tokens.length)).toBe(false);
  });

  test("unmask restores by index and tolerates a garbled placeholder", () => {
    const { masked, tokens } = mask("Replace 40-gal heater");
    expect(tokens).toEqual(["40-gal"]);
    expect(unmask(masked.replace("Replace", "Cambiar").replace("heater", "calentador"), tokens)).toBe(
      "Cambiar 40-gal calentador",
    );
    // Out-of-range sentinels are left as-is rather than throwing.
    expect(unmask("Cambiar ⟦9⟧", tokens)).toBe("Cambiar ⟦9⟧");
  });

  test("abbreviation matching respects token boundaries (AC vs. a word)", () => {
    // "AC" the unit is protected; "AC" inside a larger word is not a lone token.
    const { tokens } = mask("AC unit down; replaced the contactor.");
    expect(tokens).toContain("AC");
    // No false-positive on an ordinary word that merely contains the letters.
    const clean = mask("Back door lock sticks.");
    expect(clean.tokens).toHaveLength(0);
  });
});
