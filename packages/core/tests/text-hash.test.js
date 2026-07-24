import { describe, expect, test } from "bun:test";

import { textHash, translationKey } from "../src/text-hash";

/**
 * These vectors are the OUTPUT OF THE DEVICE'S hash
 * (apps/maintenance/lib/translation/hash.ts). If this test ever fails, the
 * server and device caches have diverged and a server-computed translation
 * will never be found by a phone — the whole pre-cache scheme silently breaks.
 * Do not "fix" these values to match a changed algorithm; fix the algorithm.
 */
describe("textHash parity with the device", () => {
  const vectors = {
    "": "ztntfp",
    "Water heater leaking": "1amf1ak",
    "Fix holes that allow RATS in!!!": "1179tn3",
    "my air does not work": "abwasq",
    Doors: "18w2kpa",
  };

  for (const [input, expected] of Object.entries(vectors)) {
    test(`"${input}" → ${expected}`, () => {
      expect(textHash(input)).toBe(expected);
    });
  }

  test("is deterministic", () => {
    expect(textHash("café · 3607")).toBe(textHash("café · 3607"));
  });

  test("differs when the text differs (the 'text changed' trigger)", () => {
    expect(textHash("Replace anode rod")).not.toBe(textHash("Replace anode rod at PM"));
  });
});

describe("translationKey", () => {
  test("namespaces the hash by language", () => {
    expect(translationKey("es", "Doors")).toBe("es:18w2kpa");
    expect(translationKey("en", "Doors")).toBe("en:18w2kpa");
  });
});
