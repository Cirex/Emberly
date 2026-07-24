import { describe, expect, test } from "bun:test";

import {
  chunk,
  computeTranslations,
  type BatchTranslate,
} from "@/lib/translation/cache";

describe("chunking", () => {
  test("splits pending sources into bounded groups", () => {
    const calls: number[] = [];
    const translator: BatchTranslate = async (texts) => {
      calls.push(texts.length);
      return texts.map((t) => `es:${t}`);
    };
    const sources = Array.from({ length: 125 }, (_, i) => `source ${i}`);
    return computeTranslations("es", sources, {}, translator, 50).then((out) => {
      expect(calls).toEqual([50, 50, 25]);
      expect(Object.keys(out)).toHaveLength(125);
    });
  });

  test("a failed chunk costs only its own strings", async () => {
    // The whole reason for chunking: one enormous call meant one rejection
    // erased every translation on the property.
    let call = 0;
    const translator: BatchTranslate = async (texts) => {
      call += 1;
      if (call === 2) throw new Error("session died");
      return texts.map((t) => `es:${t}`);
    };
    const sources = Array.from({ length: 6 }, (_, i) => `source ${i}`);
    const out = await computeTranslations("es", sources, {}, translator, 2);
    // Chunks 1 and 3 survive; only chunk 2's two strings are missing.
    expect(Object.keys(out)).toHaveLength(4);
  });

  test("chunk() never loses or duplicates an item", () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    expect(chunk(items, 3).flat()).toEqual(items);
    expect(chunk([], 3)).toEqual([]);
  });
});
