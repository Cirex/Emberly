import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Push notifications were dead across the entire fleet, and nothing said so.
 *
 * `push_tokens` was EMPTY for every app while five technicians used the
 * maintenance app on real iPhones daily. The cause was not code: the iOS
 * entitlements file was `<dict/>` — no `aps-environment` — so iOS refused to
 * register for remote notifications, `getExpoPushTokenAsync()` threw on every
 * launch, and the throw was swallowed by a `console.warn`. Emergency work-order
 * dispatch, a shipped feature, reached nobody.
 *
 * No runtime test could have caught it: the JS is correct, the server is
 * correct, the schema is correct. It is a BUILD configuration gap, so this test
 * checks the build configuration.
 *
 * Scope: every app in the monorepo that asks for a push token must declare the
 * entitlement in BOTH places —
 *   ios/<App>/<App>.entitlements   the committed Xcode project actually builds
 *   app.json ios.entitlements      so `expo prebuild` regenerates it
 * Missing either one puts the fleet back to silence.
 */

const REPO = path.join(import.meta.dir, "..", "..", "..");

interface App {
  name: string;
  dir: string;
  entitlements: string;
  /**
   * Whether this app has an EAS project yet. The projectId is a UUID minted by
   * `eas init` against the owner's Expo account — it cannot be invented here,
   * so the manager app's absence is a real outstanding action, not a code gap.
   */
  easProject: boolean;
}

const APPS: App[] = [
  {
    name: "maintenance",
    dir: path.join(REPO, "apps", "maintenance"),
    entitlements: path.join(
      REPO, "apps", "maintenance", "ios", "EmberlyMaintenance", "EmberlyMaintenance.entitlements",
    ),
    easProject: true,
  },
  {
    name: "manager",
    dir: path.join(REPO, "apps", "manager"),
    entitlements: path.join(
      REPO, "apps", "manager", "ios", "EmberlyManager", "EmberlyManager.entitlements",
    ),
    // No `eas init` has been run for this app. Flip to true with the assertion
    // below once it has.
    easProject: false,
  },
];

/** True when the app's own code asks Expo for a push token. */
function requestsPushToken(appDir: string): boolean {
  const push = path.join(appDir, "lib", "push.ts");
  return existsSync(push) && readFileSync(push, "utf8").includes("getExpoPushTokenAsync");
}

describe("iOS push entitlement", () => {
  test("the apps under test really do request push tokens", () => {
    // If this fails the suite below is guarding nothing.
    for (const app of APPS) {
      expect(requestsPushToken(app.dir)).toBe(true);
    }
  });

  for (const app of APPS) {
    test(`${app.name}: the built entitlements file declares aps-environment`, () => {
      const xml = readFileSync(app.entitlements, "utf8");
      expect(xml).toContain("aps-environment");
      // An empty <dict/> is exactly the state that broke this. Catch it
      // explicitly, because "contains the string" could otherwise be satisfied
      // by a comment alone.
      expect(/<key>aps-environment<\/key>\s*<string>(development|production)<\/string>/.test(xml)).toBe(
        true,
      );
    });

    test(`${app.name}: app.json carries it too, so prebuild cannot drop it`, () => {
      const config = JSON.parse(readFileSync(path.join(app.dir, "app.json"), "utf8"));
      const entitlements = config.expo?.ios?.entitlements ?? {};
      expect(entitlements["aps-environment"]).toMatch(/^(development|production)$/);
    });

    test(`${app.name}: expo-notifications is a configured plugin`, () => {
      const config = JSON.parse(readFileSync(path.join(app.dir, "app.json"), "utf8"));
      const plugins = (config.expo?.plugins ?? []).map((p: unknown) =>
        Array.isArray(p) ? p[0] : p,
      );
      expect(plugins).toContain("expo-notifications");
    });

    test(`${app.name}: EAS projectId state matches what this app can do`, () => {
      const config = JSON.parse(readFileSync(path.join(app.dir, "app.json"), "utf8"));
      const projectId = config.expo?.extra?.eas?.projectId;
      if (app.easProject) {
        expect(typeof projectId).toBe("string");
        expect(projectId.length).toBeGreaterThan(0);
      } else {
        // Documents the gap rather than going red forever: getExpoPushTokenAsync
        // needs a projectId, so this app's push registration returns
        // `no_project_id` until `eas init` is run. When it is, add the id and
        // set easProject: true above — this assertion will then require it.
        expect(projectId).toBeUndefined();
      }
    });
  }
});
