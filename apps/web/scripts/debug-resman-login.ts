/**
 * Offline ResMan staff-login debugger.
 *
 * Runs the EXACT production login flow (lib/resman-admin-login.ts →
 * traceResmanAdminLogin) against the real ResMan servers and prints a per-step
 * report, so you can see WHY a login is rejected instead of only getting
 * `invalid_credentials`. The whole point is to run it from two vantage points
 * and compare:
 *
 *   1. Your laptop (residential IP)      — is the credential + flow even valid?
 *   2. The Coolify/datacenter IP         — does that IP get a device/MFA/CAPTCHA
 *                                           challenge the laptop doesn't?
 *
 * If step 2 shows challengeMarkers (verify/device/passcode/…) while step 1
 * succeeds, it's a ResMan device/location-verification on the datacenter IP —
 * not a wrong password.
 *
 * Usage (creds come from env so they're never printed or shell-history'd):
 *   RESMAN_DEBUG_USER='staffuser' RESMAN_DEBUG_PASS='...' \
 *     bun run apps/web/scripts/debug-resman-login.ts
 *
 * Reuse the proven sync service account to isolate flow-vs-credentials:
 *   RESMAN_DEBUG_USER="$RESMAN_SYNC_USERNAME" RESMAN_DEBUG_PASS="$RESMAN_SYNC_PASSWORD" \
 *     bun run apps/web/scripts/debug-resman-login.ts
 *
 * Raw HTML for every step is written to ./.resman-debug/<step>.html for
 * inspection (open the credential-POST page — that's where a challenge shows).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { traceResmanAdminLogin, resolveResmanAdminConfig } from "../lib/resman-admin-login";

const username = process.env.RESMAN_DEBUG_USER?.trim();
const password = process.env.RESMAN_DEBUG_PASS;

if (!username || !password) {
  console.error("Set RESMAN_DEBUG_USER and RESMAN_DEBUG_PASS in the environment.");
  console.error("The password is read from env only — it is never printed or logged.");
  process.exit(1);
}

const config = resolveResmanAdminConfig();
console.log("ResMan staff-login debug");
console.log("  consumerStartUrl:", config.consumerStartUrl);
console.log("  authBaseUrl:     ", config.authBaseUrl);
console.log("  accountId:       ", config.accountId);
console.log("  companyName:     ", config.companyName);
console.log("  username:        ", username, "(password hidden)");
console.log("");

const { steps, result } = await traceResmanAdminLogin(username, password, config, { captureHtml: true });

const outDir = resolve(process.cwd(), ".resman-debug");
mkdirSync(outDir, { recursive: true });

for (const step of steps) {
  console.log(`── step: ${step.name} ─────────────────────────────`);
  console.log("  status:          ", step.status);
  console.log("  finalUrl:        ", step.finalUrl);
  console.log("  title:           ", step.title);
  console.log("  htmlLength:      ", step.htmlLength);
  if (step.csrfTokenFound !== undefined) console.log("  csrfTokenFound:  ", step.csrfTokenFound);
  if (step.formPostAction !== undefined) console.log("  formPostAction:  ", step.formPostAction);
  if (step.formPostFields !== undefined) console.log("  formPostFields:  ", step.formPostFields);
  console.log("  challengeMarkers:", step.challengeMarkers.length ? step.challengeMarkers.join(", ") : "(none)");
  if (step.html !== undefined) {
    const file = resolve(outDir, `${step.name}.html`);
    writeFileSync(file, step.html);
    console.log("  html dumped to:  ", file);
  }
  console.log("");
}

console.log("── result ───────────────────────────────────────");
if (result.ok) {
  console.log("  ✓ LOGIN SUCCEEDED");
  console.log("  identity:", JSON.stringify(result.identity));
} else {
  console.log(`  ✗ LOGIN FAILED — reason: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
  const anyChallenge = steps.some((s) => s.challengeMarkers.length > 0);
  if (result.reason === "invalid_credentials") {
    console.log(
      anyChallenge
        ? "  → Challenge keywords present: likely a device/MFA/CAPTCHA page, NOT a wrong password."
        : "  → No challenge keywords: looks like a genuine wrong-password / staff-portal rejection.",
    );
  }
}
