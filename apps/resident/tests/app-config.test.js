const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("app display name is Emberly Apartments while internal identifiers stay resident-scoped", () => {
  const appConfig = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "app.json"), "utf8")
  ).expo;
  const infoPlist = fs.readFileSync(
    path.join(process.cwd(), "ios/EmberlyResident/Info.plist"),
    "utf8"
  );

  assert.equal(appConfig.name, "Emberly Apartments");
  assert.equal(appConfig.slug, "emberly-resident");
  assert.equal(appConfig.scheme, "com.emberly.resident");
  assert.equal(appConfig.ios.bundleIdentifier, "com.emberly.resident");
  assert.equal(appConfig.android.package, "com.emberly.resident");
  assert.match(infoPlist, /<key>CFBundleDisplayName<\/key>\s*<string>Emberly Apartments<\/string>/);
});

test("guest pass form requires guest name, email, and phone before submit", () => {
  const screen = fs.readFileSync(
    path.join(process.cwd(), "app/(tabs)/guest-pass.tsx"),
    "utf8"
  );

  assert.match(screen, /Please enter the guest name\./);
  assert.match(screen, /Please enter the guest email\./);
  assert.match(screen, /Please enter the guest phone number\./);
});

test("guest pass history supports swipe-left revoke for active passes", () => {
  const screen = fs.readFileSync(
    path.join(process.cwd(), "app/(tabs)/guest-pass.tsx"),
    "utf8"
  );
  const api = fs.readFileSync(path.join(process.cwd(), "lib/api.ts"), "utf8");

  assert.match(api, /export async function revokeGuestPass/);
  assert.match(api, /\/resident\/guest-passes\/\$\{passId\}\/revoke/);
  assert.match(screen, /PanResponder/);
  assert.match(screen, /SwipeableGuestPassRow/);
  assert.match(screen, /handleRevokePass/);
  assert.match(screen, /FULL_SWIPE_REVOKE_THRESHOLD/);
  assert.match(screen, /requestRevoke/);
  assert.match(screen, /revokeAction/);
  assert.doesNotMatch(screen, /rowTrashButton/);
  assert.match(screen, /useEffect\(\(\) => \{/);
});

test("resident app uses shared liquid glass surfaces across primary views", () => {
  const tabsLayout = fs.readFileSync(
    path.join(process.cwd(), "app/(tabs)/_layout.tsx"),
    "utf8"
  );

  assert.match(tabsLayout, /name:\s*["']settings["']/);
  assert.match(tabsLayout, /title:\s*["']Settings["']/);
  assert.match(tabsLayout, /icon:\s*["']qr-code-outline["']/);
  assert.match(tabsLayout, /icon:\s*["']people-outline["']/);
  assert.doesNotMatch(tabsLayout, /title:\s*["']Profile["']/);

  const sharedSurface = fs.readFileSync(
    path.join(process.cwd(), "components/resident-glass.tsx"),
    "utf8"
  );
  assert.match(sharedSurface, /export function ResidentScreen/);
  assert.match(sharedSurface, /export function GlassPanel/);
  assert.match(sharedSurface, /export function GlassButton/);

  for (const route of [
    "app/(auth)/login.tsx",
    "app/(auth)/select-resident.tsx",
    "app/(tabs)/index.tsx",
    "app/(tabs)/guest-pass.tsx",
    "app/(tabs)/settings.tsx",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), route), "utf8");
    assert.match(source, /@\/components\/resident-glass/);
    assert.match(source, /ResidentScreen/);
    assert.match(source, /GlassPanel/);
  }
});

test("settings screen exposes resident security controls", () => {
  const settings = fs.readFileSync(
    path.join(process.cwd(), "app/(tabs)/settings.tsx"),
    "utf8"
  );

  assert.match(settings, /localUnlockEnabled/);
  assert.match(settings, /enableLocalUnlock/);
  assert.match(settings, /disableLocalUnlock/);
  assert.match(settings, /Sign Out/);
  assert.match(settings, /Version/);
  assert.doesNotMatch(settings, /Ledger ID/);
  assert.doesNotMatch(settings, /label="API"/);
});

test("login screen matches the Emberly liquid glass reference structure", () => {
  const login = fs.readFileSync(
    path.join(process.cwd(), "app/(auth)/login.tsx"),
    "utf8"
  );

  assert.match(login, /Welcome Home/);
  assert.match(login, /Sign in to access your resident account\./);
  assert.match(login, /Use Face ID/);
  assert.match(login, /Having issues\? Contact your property manager\./);
  assert.doesNotMatch(login, /Use your ResMan login/);
  assert.match(login, /loginPanel/);
  assert.match(login, /brandLogo/);
});

test("my pass and guest pass screens use the Emberly reference surfaces", () => {
  const myPass = fs.readFileSync(
    path.join(process.cwd(), "app/(tabs)/index.tsx"),
    "utf8"
  );
  const guestPass = fs.readFileSync(
    path.join(process.cwd(), "app/(tabs)/guest-pass.tsx"),
    "utf8"
  );

  assert.match(myPass, /entryPassPanel/);
  assert.match(myPass, /passHeroHeader/);
  assert.match(myPass, /logo-flower-transparent\.png/);
  assert.match(myPass, /Verified/);
  assert.match(myPass, /How it works/);
  assert.doesNotMatch(myPass, /Resident Access/);
  assert.doesNotMatch(myPass, /Valid for building entry/);

  assert.match(guestPass, /invitePanel/);
  assert.match(guestPass, /guestHeroHeader/);
  assert.match(guestPass, /guestTicketPanel/);
  assert.match(guestPass, /logo-flower-transparent\.png/);
  assert.match(guestPass, /Create a Guest Pass/);
  assert.match(guestPass, /24-hour single-use access/);
  assert.match(guestPass, /Recent Passes/);
  assert.match(guestPass, /guestPassNote/);
});

test("guest pass QR preview container is centered instead of stretching across the panel", () => {
  const guestPass = fs.readFileSync(
    path.join(process.cwd(), "app/(tabs)/guest-pass.tsx"),
    "utf8"
  );
  const qrCenterStyle = guestPass.match(/qrCenter:\s*\{[\s\S]*?\n  \},/)?.[0] ?? "";

  assert.match(qrCenterStyle, /alignSelf:\s*['"]center['"]/);
  assert.match(qrCenterStyle, /width:\s*204/);
});
