import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const APP_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, "app.json"), "utf8")).expo;
const INFO_PLIST = fs.readFileSync(path.join(ROOT, "ios/EmberlyManager/Info.plist"), "utf8");

const DISPLAY_NAME = "Emberly Manager";

/**
 * The same display-name guard the other three apps carry.
 *
 * `CFBundleName` is `$(PRODUCT_NAME)` — the Xcode target, "EmberlyManager",
 * which cannot hold a space. `CFBundleDisplayName` is the human one, and iOS
 * falls back to the target name without complaint when it is absent.
 *
 * Manager has only one plugin-seeded prompt (expo-secure-store's Face ID), and
 * it was still carrying the stock "Allow $(PRODUCT_NAME) to access your Face ID
 * biometric data." — the unspaced name, shown to a property manager.
 */

describe("the name people see", () => {
  test("app.json carries the spaced display name", () => {
    expect(APP_JSON.name).toBe(DISPLAY_NAME);
    expect(APP_JSON.slug).toBe("emberly-manager");
    expect(APP_JSON.ios.bundleIdentifier).toBe("com.emberly.manager");
    expect(APP_JSON.android.package).toBe("com.emberly.manager");
  });

  test("app.json pins CFBundleDisplayName rather than leaving it to be derived", () => {
    expect(APP_JSON.ios.infoPlist.CFBundleDisplayName).toBe(DISPLAY_NAME);
  });

  test("the committed Info.plist agrees with it", () => {
    expect(INFO_PLIST).toMatch(
      new RegExp(`<key>CFBundleDisplayName</key>\\s*<string>${DISPLAY_NAME}</string>`),
    );
  });
});

describe("permission prompts", () => {
  const usageStrings = [...INFO_PLIST.matchAll(/<key>(NS\w*UsageDescription)<\/key>\s*<string>([\s\S]*?)<\/string>/g)];

  test("there are some to check", () => {
    expect(usageStrings.length).toBeGreaterThan(0);
  });

  for (const [, key, value] of usageStrings) {
    test(`${key} names the app the way the user knows it`, () => {
      expect(value).not.toContain("$(PRODUCT_NAME)");
      expect(value).not.toContain("EmberlyManager");
    });
  }

  test("the one prompt expo-secure-store can re-seed is answered in app.json", () => {
    expect(APP_JSON.ios.infoPlist.NSFaceIDUsageDescription).toBeString();
  });
});
