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

describe("incremental commits", () => {
  test("publishes each chunk as it lands, not only at the end", async () => {
    // The backfill runs for minutes over thousands of sources; waiting for the
    // final chunk would leave every screen in English the whole time.
    const commits: number[] = [];
    const sources = Array.from({ length: 10 }, (_, i) => `s${i}`);
    await computeTranslations("es", sources, {}, fakeTranslate, 4, (landed) => {
      commits.push(Object.keys(landed).length);
    });
    expect(commits).toEqual([4, 4, 2]);
  });

  test("a failed chunk publishes nothing for itself but does not stop the rest", async () => {
    let call = 0;
    const flaky: BatchTranslate = async (texts) => {
      call += 1;
      if (call === 1) throw new Error("session died");
      return texts.map((t) => `es:${t}`);
    };
    const commits: number[] = [];
    const sources = ["a", "b", "c", "d"];
    const out = await computeTranslations("es", sources, {}, flaky, 2, (landed) => {
      commits.push(Object.keys(landed).length);
    });
    expect(commits).toEqual([2]); // only the surviving chunk
    expect(Object.keys(out)).toHaveLength(2);
  });

  test("onChunk is optional — the batch result is unchanged without it", async () => {
    const out = await computeTranslations("es", ["a", "b", "c"], {}, fakeTranslate, 2);
    expect(Object.keys(out)).toHaveLength(3);
  });
});

describe("server pre-cache merge", () => {
  const { textHash } = require("@/lib/translation/hash");

  test("server entries are keyed identically to on-device ones", () => {
    // The whole scheme rests on this: the server hashes the SOURCE and the app
    // looks up `${lang}:${hash(source)}`. If these ever diverge, a
    // server-computed translation is invisible to the phone.
    const source = "Water heater leaking";
    const serverKeyed: TranslationEntries = { [`es:${textHash(source)}`]: "Calentador con fugas" };
    expect(lookupTranslation(serverKeyed, "es", source)).toBe("Calentador con fugas");
  });

  test("a merged source is no longer pending, so it never re-translates", async () => {
    const source = "Doors";
    const merged: TranslationEntries = { [`es:${textHash(source)}`]: "Puertas" };
    // pendingSources is what drives the on-device pass; a server-merged source
    // must drop out of it entirely.
    expect(pendingSources("es", [source], merged)).toEqual([]);

    let calls = 0;
    const counting: BatchTranslate = async (texts) => {
      calls += 1;
      return texts.map((t) => `es:${t}`);
    };
    const out = await computeTranslations("es", [source], merged, counting);
    expect(calls).toBe(0);
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("only field-authored residue reaches the device translator", async () => {
    // Server covered the ResMan prose; the tech's own note did not exist there.
    const fromServer = "Replace the T&P valve";
    const techNote = "Cambié la válvula y probé la línea";
    const merged: TranslationEntries = { [`es:${textHash(fromServer)}`]: "Reemplazar la válvula T&P" };

    const seen: string[][] = [];
    const spy: BatchTranslate = async (texts) => {
      seen.push(texts);
      return texts.map((t) => `es:${t}`);
    };
    await computeTranslations("es", [fromServer, techNote], merged, spy);
    expect(seen).toEqual([[techNote]]);
  });
});
