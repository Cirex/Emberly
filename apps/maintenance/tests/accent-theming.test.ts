import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACCENT_THEMES, type AccentThemeId } from "@emberly/core";

/**
 * The accent picker used to change almost nothing: 117 call sites across 23
 * files imported olive constants, and another 48 wrote olive as a raw rgba
 * literal, while the picker only tinted the mark and the tab bar. These tests
 * guard both halves — that the ramp exists and is legible, and that the app
 * doesn't quietly go back to hardcoding it.
 */

const PAPER = "#FAF7F0";
const GLASS_LIGHT = "#F2EFE7";
const GLASS_DARK = "#20252E";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const IDS = Object.keys(ACCENT_THEMES) as AccentThemeId[];
const HEX = /^#[0-9A-F]{6}$/;

describe("accent ramp", () => {
  test("every accent defines the full set of roles", () => {
    for (const id of IDS) {
      const t = ACCENT_THEMES[id];
      expect({ id, hex: HEX.test(t.hex), text: HEX.test(t.text) }).toEqual({
        id,
        hex: true,
        text: true,
      });
      expect({ id, glass: HEX.test(t.glass), glassDark: HEX.test(t.glassDark) }).toEqual({
        id,
        glass: true,
        glassDark: true,
      });
      expect({ id, glowLight: t.glowLight.length, glowDark: t.glowDark.length }).toEqual({
        id,
        glowLight: 3,
        glowDark: 3,
      });
    }
  });

  test("the text tone clears WCAG AA on warm paper", () => {
    // The olive this replaced measured 3.32:1 and was used on 9–12pt labels,
    // in an app with a dedicated sunlight mode. 4.5 is the floor.
    for (const id of IDS) {
      const ratio = contrast(ACCENT_THEMES[id].text, PAPER);
      expect({ id, passes: ratio >= 4.5 }).toEqual({ id, passes: true });
    }
  });

  test("the glass tones clear AA on the chrome they sit in", () => {
    for (const id of IDS) {
      const light = contrast(ACCENT_THEMES[id].glass, GLASS_LIGHT);
      const dark = contrast(ACCENT_THEMES[id].glassDark, GLASS_DARK);
      expect({ id, light: light >= 4.5, dark: dark >= 4.5 }).toEqual({
        id,
        light: true,
        dark: true,
      });
    }
  });

  test("glass is at least as deep as text, so the two roles stay distinct", () => {
    for (const id of IDS) {
      const t = ACCENT_THEMES[id];
      expect({ id, deeper: luminance(t.glass) <= luminance(t.text) }).toEqual({
        id,
        deeper: true,
      });
    }
  });

  test("the fill tone is the accent itself, unmodified", () => {
    // `hex` is the brand value the picker's swatch shows; the ramp derives from
    // it rather than replacing it, so a swatch always matches what it paints.
    expect(ACCENT_THEMES.olive.hex).toBe("#A2A921");
    expect(ACCENT_THEMES.ember.hex).toBe("#C2410C");
  });
});

// ---------------------------------------------------------------------------

/** Every .ts/.tsx under the app's own source, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "tests" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const ROOT = join(import.meta.dir, "..");
const SOURCES = ["app", "components", "lib"].flatMap((d) => sourceFiles(join(ROOT, d)));

describe("the accent is not hardcoded", () => {
  /**
   * Fixed swatch palettes the technician picks FROM — a pin colour they chose
   * must not move when the theme does. These are the only legitimate homes for
   * a literal olive.
   */
  const ALLOWED = [
    join(ROOT, "lib/stores/annotations.ts"),
    join(ROOT, "components/map/AnnotationEditorDialog.tsx"),
  ];

  test("no olive rgba literals outside the fixed swatch palettes", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (ALLOWED.includes(file)) continue;
      const text = readFileSync(file, "utf8");
      // OLIVE and OLIVE_TEXT as raw rgba triples.
      if (/rgba\(\s*162,\s*169,\s*33\s*,|rgba\(\s*132,\s*143,\s*13\s*,/.test(text)) {
        offenders.push(file.slice(ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the olive constants are not imported by the maintenance UI", () => {
    // They still exist in @emberly/core for the security app and for surfaces
    // that must stay olive; importing one here means a call site the accent
    // cannot reach.
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const text = readFileSync(file, "utf8");
      // Only IMPORTS count — use-accent.ts names the constants in its doc
      // comment to explain what it replaced, which is documentation, not a
      // hardcoded colour.
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*(?:tokens|core)["']/g)) {
        if (/\bOLIVE(_TEXT|_GLASS|_GLASS_DARK)?\b/.test(m[1])) {
          offenders.push(file.slice(ROOT.length + 1));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
