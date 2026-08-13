import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const APP_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, "app.json"), "utf8")).expo;
const INFO_PLIST = fs.readFileSync(path.join(ROOT, "ios/EmberlyMaintenance/Info.plist"), "utf8");

const DISPLAY_NAME = "Emberly Maintenance";

/**
 * What the technician reads on the Home Screen and in permission prompts.
 *
 * Two different Info.plist keys carry a name, and only one of them is meant for
 * people. `CFBundleName` is `$(PRODUCT_NAME)` — the Xcode target, which cannot
 * hold a space, so it is "EmberlyMaintenance". `CFBundleDisplayName` is the
 * human one. iOS labels the icon with the display name and silently falls back
 * to `CFBundleName` when it is missing, which is exactly how the app shipped
 * with "EmberlyMaintenance" under its icon.
 *
 * The same collapse happens in the permission sheets: Expo's config plugins
 * seed their usage strings with the literal "Allow $(PRODUCT_NAME) to ...", and
 * that token is expanded by the build to the target name, not the display name.
 * So a plugin default that is never overridden puts the unspaced name in front
 * of the user a second time.
 *
 * `applyPermissions` in @expo/config-plugins reads
 * `permissions[key] || infoPlist[key] || default`, so a string declared in
 * app.json's `ios.infoPlist` survives a prebuild and the plugin default loses.
 * That makes app.json the durable place to fix it, and this file the place that
 * notices when a newly added plugin drags another default back in.
 */

describe("the name people see", () => {
  test("app.json carries the spaced display name", () => {
    expect(APP_JSON.name).toBe(DISPLAY_NAME);
    expect(APP_JSON.slug).toBe("emberly-maintenance");
    expect(APP_JSON.ios.bundleIdentifier).toBe("com.emberly.maintenance");
    expect(APP_JSON.android.package).toBe("com.emberly.maintenance");
  });

  test("app.json pins CFBundleDisplayName rather than leaving it to be derived", () => {
    // Prebuild would derive it from `name` anyway; pinning it means the value
    // is stated where the rest of the Info.plist is stated, not implied.
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
      expect(value).not.toContain("EmberlyMaintenance");
    });
  }
});
