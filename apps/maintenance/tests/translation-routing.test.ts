import { describe, expect, test } from "bun:test";

import { computeTranslations, type BatchTranslate } from "@/lib/translation/cache";
import { normalizeLang, planTranslation } from "@/lib/translation/routing";

describe("normalizeLang", () => {
  test("collapses regional variants to a supported base", () => {
    expect(normalizeLang("en-US")).toBe("en");
    expect(normalizeLang("es_419")).toBe("es");
    expect(normalizeLang("ES")).toBe("es");
  });

  test("null for anything the app can't render or translate", () => {
    expect(normalizeLang("und")).toBeNull();
    expect(normalizeLang("pt")).toBeNull();
    expect(normalizeLang("zh-Hans")).toBeNull();
  });
});

describe("planTranslation", () => {
  test("groups only sources in a different supported language", () => {
    const sources = ["English one", "Uno español", "Dos español", "English two"];
    const detected = ["en", "es", "es", "en"];
    // Reader is English: only the two Spanish strings translate, es → en.
    const groups = planTranslation(sources, detected, "en");
    expect(groups).toEqual([{ from: "es", texts: ["Uno español", "Dos español"] }]);
  });

  test("a Spanish reader gets the English strings, the reverse direction", () => {
    const groups = planTranslation(["Hello", "Hola"], ["en", "es"], "es");
    expect(groups).toEqual([{ from: "en", texts: ["Hello"] }]);
  });

  test("skips undetermined and unsupported languages", () => {
    const groups = planTranslation(["a", "b", "c"], ["und", "pt", "es"], "en");
    expect(groups).toEqual([{ from: "es", texts: ["c"] }]);
  });

  test("misaligned detection translates nothing rather than the wrong language", () => {
    expect(planTranslation(["a", "b"], ["es"], "en")).toEqual([]);
  });
});

describe("computeTranslations with detection", () => {
  const echo: BatchTranslate = async (texts, from, to) => texts.map((t) => `${from}->${to}:${t}`);

  test("translates each detected language toward the reader", async () => {
    const sources = ["English note", "Nota española"];
    const detector = async () => ["en", "es"];
    // English reader: only the Spanish source is translated (es → en).
    const out = await computeTranslations("en", sources, {}, echo, 200, undefined, detector);
    const values = Object.values(out);
    expect(values).toEqual(["es->en:Nota española"]);
  });

  test("a source already in the reader's language is never cached", async () => {
    const detector = async () => ["en"];
    const out = await computeTranslations("en", ["Plain English"], {}, echo, 200, undefined, detector);
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("default detector preserves one-directional en → es behaviour", async () => {
    // No detector injected: everything is assumed English, so a Spanish reader
    // still gets all of it — exactly the original pipeline.
    const out = await computeTranslations("es", ["Water heater"], {}, echo);
    expect(Object.values(out)).toEqual(["en->es:Water heater"]);
  });
});
