import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const APP_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, "app.json"), "utf8")).expo;
const INFO_PLIST = fs.readFileSync(path.join(ROOT, "ios/EmberlySecurity/Info.plist"), "utf8");

const DISPLAY_NAME = "Emberly Security";

/**
 * What the guard reads on the Home Screen and in permission prompts.
 *
 * Two different Info.plist keys carry a name, and only one of them is meant for
 * people. `CFBundleName` is `$(PRODUCT_NAME)` — the Xcode target, which cannot
 * hold a space, so it is "EmberlySecurity". `CFBundleDisplayName` is the human
 * one, and iOS falls back to `CFBundleName` without complaint when the display
 * name is missing.
 *
 * This app's display name has been right since the first commit, so the icon
 * label only goes wrong when the installed build predates the source. The
 * permission sheets were the live version of the same bug: expo-location and
 * expo-secure-store seed their usage strings with "Allow $(PRODUCT_NAME) to
 * ...", and the build expands that token to the target name. Four prompts —
 * Face ID, microphone, motion, and both always-location variants — said
 * "EmberlySecurity" to whoever tapped them.
 *
 * `applyPermissions` in @expo/config-plugins reads
 * `permissions[key] || infoPlist[key] || default`, so a string declared in
 * app.json's `ios.infoPlist` survives a prebuild and the plugin default loses.
 * That matters more here than in the sibling apps: expo-location is an active
 * plugin, so deleting these keys would only invite them back.
 */

describe("the name people see", () => {
  test("app.json carries the spaced display name", () => {
    expect(APP_JSON.name).toBe(DISPLAY_NAME);
    expect(APP_JSON.slug).toBe("emberly-security");
    expect(APP_JSON.ios.bundleIdentifier).toBe("com.emberly.security");
    expect(APP_JSON.android.package).toBe("com.emberly.security");
  });

  test("app.json pins CFBundleDisplayName rather than leaving it to be derived", () => {
    expect(APP_JSON.ios.infoPlist.CFBundleDisplayName).toBe(DISPLAY_NAME);
  });

  test("the committed Info.plist agrees with it", () => {
    // ios/ is a committed bare project, so this file — not app.json — is what
    // an Xcode or EAS build actually reads.
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
      expect(value).not.toContain("EmberlySecurity");
    });
  }

  test("every prompt the plugins can re-seed is answered in app.json", () => {
    // The plugin default only loses to a value that is already there. Anything
    // expo-location or expo-secure-store owns has to be declared, or the next
    // prebuild puts $(PRODUCT_NAME) back.
    for (const key of [
      "NSFaceIDUsageDescription",
      "NSMotionUsageDescription",
      "NSLocationWhenInUseUsageDescription",
      "NSLocationAlwaysUsageDescription",
      "NSLocationAlwaysAndWhenInUseUsageDescription",
    ]) {
      expect(APP_JSON.ios.infoPlist[key]).toBeString();
    }
  });
});
