#!/usr/bin/env bun
/**
 * Capture App Store screenshots from the iOS Simulator at Apple's exact sizes.
 *
 *   bun scripts/capture-store-screenshots.mjs maintenance /path/to/EmberlyMaintenance.app
 *   bun scripts/capture-store-screenshots.mjs security    /path/to/EmberlySecurity.app
 *
 * Output lands in apps/<app>/store/screenshots/<device>/NN_<name>.png, using
 * fastlane deliver's naming so `deliver` can upload the directory as-is. EAS
 * Metadata does NOT handle screenshots — it covers text and settings only — so
 * these are uploaded by fastlane or by hand.
 *
 * WHY A SCRIPT. Store screenshots have to be recaptured every time the UI moves,
 * at exact pixel sizes, across two device classes, for every app. Doing that by
 * hand is how you end up shipping a screenshot of a screen that no longer
 * exists, or one rejected for being 4px off.
 *
 * The two device sizes below were verified by capturing from these simulators
 * rather than taken from documentation:
 *   iPhone 17 Pro Max     -> 1320x2868  (Apple's "6.9 inch" slot)
 *   iPad Pro 13-inch (M5) -> 2064x2752  (Apple's "iPad 13 inch" slot)
 * Both apps declare supportsTablet, so both need both sets.
 *
 * The .app must be a SIMULATOR build. A Debug-iphoneos build cannot install here
 * — wrong platform slice — which is the first thing that goes wrong.
 *
 * Ported from capture-store-screenshots.sh. Behaviour is unchanged; the
 * `label:name:WxH` strings that had to be split with three rounds of `${x%%:*}`
 * are now a typed array, and the Info.plist reads go through one helper instead
 * of two PlistBuddy invocations parsed by grep.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const DEVICES = [
  { label: "iphone-6.9", simulator: "iPhone 17 Pro Max", expected: "1320x2868" },
  { label: "ipad-13", simulator: "iPad Pro 13-inch (M5)", expected: "2064x2752" },
];

/**
 * Screens to capture. Deep links would be better than sleeps, but the apps have
 * no screenshot-mode entry points yet, so this captures the launch state and
 * leaves the rest for a human to drive. Extend as deep links are added.
 */
const SHOTS = ["01_launch"];

/** No launch-complete signal exists; give the JS bundle time to render. */
const RENDER_WAIT_MS = 8_000;

async function plist(appPath, key) {
  const result = await $`/usr/libexec/PlistBuddy -c ${`Print :${key}`} ${path.join(appPath, "Info.plist")}`
    .nothrow().quiet();
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

async function udidFor(simulatorName) {
  const listed = await $`xcrun simctl list devices available`.nothrow().quiet();
  for (const line of listed.stdout.toString().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(simulatorName)) continue;
    const match = /\(([A-F0-9-]{36})\)/.exec(trimmed);
    if (match) return match[1];
  }
  return null;
}

async function pixelSize(file) {
  const out = (await $`sips -g pixelWidth -g pixelHeight ${file}`.nothrow().quiet()).stdout.toString();
  const w = /pixelWidth:\s*(\d+)/.exec(out)?.[1] ?? "?";
  const h = /pixelHeight:\s*(\d+)/.exec(out)?.[1] ?? "?";
  return `${w}x${h}`;
}

async function main() {
  const [appName, appPath] = process.argv.slice(2);
  if (!appName || !appPath) {
    console.error("usage: bun scripts/capture-store-screenshots.mjs <maintenance|security|manager> <path-to-simulator-.app>");
    return 64;
  }

  const repoRoot = path.resolve(import.meta.dir, "..");
  const outRoot = path.join(repoRoot, "apps", appName, "store", "screenshots");

  if (!existsSync(appPath)) {
    console.error(`error: no .app at ${appPath}`);
    return 66;
  }

  // Refuse a device build early, with the reason. Installing it fails with a
  // much less obvious message.
  const platforms = await plist(appPath, "CFBundleSupportedPlatforms:0");
  if (platforms.includes("iPhoneOS")) {
    console.error(`error: ${appPath} is a DEVICE build (CFBundleSupportedPlatforms: iPhoneOS).`);
    console.error("       The simulator needs a Debug-iphonesimulator build.");
    return 65;
  }

  const bundleId = await plist(appPath, "CFBundleIdentifier");
  if (!bundleId) {
    console.error(`error: could not read CFBundleIdentifier from ${appPath}/Info.plist`);
    return 66;
  }
  console.log(`app: ${appName}  bundle: ${bundleId}`);

  for (const device of DEVICES) {
    const udid = await udidFor(device.simulator);
    if (!udid) {
      console.error(`  skip ${device.label} — no simulator named '${device.simulator}'`);
      continue;
    }

    console.log(`  ${device.label}  (${device.simulator})`);
    // Boot if needed; already-booted is not an error worth stopping for.
    if ((await $`xcrun simctl bootstatus ${udid} -b`.nothrow().quiet()).exitCode !== 0) {
      await $`xcrun simctl boot ${udid}`.nothrow().quiet();
      await $`xcrun simctl bootstatus ${udid} -b`.nothrow().quiet();
    }

    await $`xcrun simctl install ${udid} ${appPath}`;
    await $`xcrun simctl launch ${udid} ${bundleId}`.quiet();
    await Bun.sleep(RENDER_WAIT_MS);

    const outDir = path.join(outRoot, device.label);
    await mkdir(outDir, { recursive: true });

    for (const shot of SHOTS) {
      const out = path.join(outDir, `${shot}.png`);
      await $`xcrun simctl io ${udid} screenshot --type=png ${out}`.nothrow().quiet();
      const got = await pixelSize(out);
      if (got !== device.expected) {
        console.error(`    ✗ ${shot} — got ${got}, App Store expects ${device.expected}`);
        return 70;
      }
      console.log(`    ✓ ${shot}  ${got}`);
    }

    await $`xcrun simctl terminate ${udid} ${bundleId}`.nothrow().quiet();
  }

  console.log();
  console.log(`wrote ${outRoot}`);
  console.log("note: only the launch screen is captured automatically. Apple wants 3-10 per");
  console.log("      device; drive the app to the other screens and re-run, or add deep");
  console.log("      links and extend SHOTS above.");
  return 0;
}

process.exit(await main());
