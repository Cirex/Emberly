import { describe, expect, test } from "bun:test";
import {
  computeTranslations,
  lookupTranslation,
  pendingSources,
  type BatchTranslate,
  type TranslationEntries,
} from "@/lib/translation/cache";

/** A fake translator: prefixes "es:" and keeps sentinels — stands in for the
 *  native Apple module so the cache logic is testable without a device. */
const fakeTranslate: BatchTranslate = async (texts) => texts.map((t) => `es:${t}`);

describe("translation cache logic", () => {
  test("translates and looks up by source; English is never stored", async () => {
    const next = await computeTranslations("es", ["Water heater leaking", "Bath fan rattle"], {}, fakeTranslate);
    expect(lookupTranslation(next, "es", "Water heater leaking")).toBe("es:Water heater leaking");
    expect(lookupTranslation(next, "es", "Bath fan rattle")).toBe("es:Bath fan rattle");

    const noop = await computeTranslations("en", ["Water heater leaking"], {}, fakeTranslate);
    expect(noop).toEqual({});
    expect(lookupTranslation(noop, "en", "Water heater leaking")).toBeNull();
  });

  test("only un-cached, distinct, non-blank sources are sent to the translator", async () => {
    const calls: string[][] = [];
    const spy: BatchTranslate = async (texts) => {
      calls.push(texts);
      return texts.map((t) => `es:${t}`);
    };
    const first = await computeTranslations("es", ["Leak", "Leak", "  ", ""], {}, spy);
    await computeTranslations("es", ["Leak", "New one"], first, spy);
    expect(calls).toEqual([["Leak"], ["New one"]]);
    expect(pendingSources("es", ["Leak", "New one"], first)).toEqual(["New one"]);
  });

  test("protected tokens survive translation (mask round-trip)", async () => {
    const next = await computeTranslations("es", ["Swap 40-gal HWH at 1710 CW-3"], {}, fakeTranslate);
    const out = lookupTranslation(next, "es", "Swap 40-gal HWH at 1710 CW-3");
    expect(out).toContain("40-gal");
    expect(out).toContain("HWH");
    expect(out).toContain("1710 CW-3");
    expect(out?.startsWith("es:")).toBe(true);
  });

  test("a result that dropped a placeholder is rejected (English kept)", async () => {
    const bad: BatchTranslate = async (texts) => texts.map((t) => t.replace(/⟦\d+⟧/g, ""));
    const next = await computeTranslations("es", ["Replace 40-gal HWH"], {}, bad);
    expect(lookupTranslation(next, "es", "Replace 40-gal HWH")).toBeNull();
  });

  test("an unavailable translator (throws) yields no entries", async () => {
    const throwing: BatchTranslate = async () => {
      throw new Error("unavailable");
    };
    const next = await computeTranslations("es", ["Water heater leaking"], {}, throwing);
    expect(next).toEqual({});
  });

  test("lookup ignores blank sources", () => {
    const entries: TranslationEntries = {};
    expect(lookupTranslation(entries, "es", "   ")).toBeNull();
  });
});
