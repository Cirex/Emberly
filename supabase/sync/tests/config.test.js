
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  makeResManConfiguration,
  MULTI_SOUTH_CONFIGURATION,
  resManConfigurationFromEnv,
  resManCredentialsFromEnv,
  RESMAN_SYNC_TUNING,
  RESMAN_COMPANIES,
} = require("../src/resman/config");
const { ENV } = require("../src/config/env");

test("makeResManConfiguration derives consumer + auth base URLs", () => {
  const config = makeResManConfiguration({
    subdomain: "multisouth",
    accountId: "1659",
    companyName: "The Multi-South Group",
  });
  assert.ok(config);
  assert.equal(config.consumerStartUrl, "https://multisouth.myresman.com/");
  assert.equal(config.authBaseUrl, "https://multisouth.auth.myresman.com");
  assert.equal(config.accountId, "1659");
});

test("makeResManConfiguration trims the subdomain and rejects empty input", () => {
  const trimmed = makeResManConfiguration({ subdomain: "  multisouth  ", accountId: "1", companyName: "x" });
  assert.equal(trimmed?.subdomain, "multisouth");
  assert.equal(makeResManConfiguration({ subdomain: "   ", accountId: "1", companyName: "x" }), null);
  assert.equal(makeResManConfiguration({ subdomain: "", accountId: "1", companyName: "x" }), null);
});

test("MULTI_SOUTH_CONFIGURATION matches the Swift default (account 1659)", () => {
  assert.equal(MULTI_SOUTH_CONFIGURATION.subdomain, "multisouth");
  assert.equal(MULTI_SOUTH_CONFIGURATION.accountId, "1659");
  assert.equal(MULTI_SOUTH_CONFIGURATION.companyName, "The Multi-South Group");
  assert.equal(RESMAN_COMPANIES.multiSouth.id, "multi-south");
});

test("resManConfigurationFromEnv applies subdomain + account overrides", () => {
  const config = resManConfigurationFromEnv({
    [ENV.RESMAN_SUBDOMAIN]: "otherco",
    [ENV.RESMAN_ACCOUNT_ID]: "9999",
  });
  assert.equal(config.subdomain, "otherco");
  assert.equal(config.consumerStartUrl, "https://otherco.myresman.com/");
  assert.equal(config.accountId, "9999");
});

test("resManConfigurationFromEnv falls back to the built-in config when unset", () => {
  const config = resManConfigurationFromEnv({});
  assert.equal(config, MULTI_SOUTH_CONFIGURATION);
});

test("resManCredentialsFromEnv reads the injected env var names", () => {
  const creds = resManCredentialsFromEnv({
    [ENV.RESMAN_SYNC_USERNAME]: "sync-user",
    [ENV.RESMAN_SYNC_PASSWORD]: "sync-pass",
  });
  assert.deepEqual(creds, { username: "sync-user", password: "sync-pass" });
});

test("resManCredentialsFromEnv fails closed when a credential is missing", () => {
  assert.throws(() => resManCredentialsFromEnv({ [ENV.RESMAN_SYNC_USERNAME]: "only-user" }));
  assert.throws(() => resManCredentialsFromEnv({}));
});

test("RESMAN_SYNC_TUNING keeps the design's safe concurrency default", () => {
  // Design §8: raising ResMan concurrency above the shipped default produced
  // HTML error pages, so the default connections-per-host stays at 6.
  assert.equal(RESMAN_SYNC_TUNING.defaultConnectionsPerHost, 6);
  // Retry is wired into the scrape HTTP layer (withResManRetries).
  assert.equal(RESMAN_SYNC_TUNING.requestRetryAttempts, 3);
  assert.equal(RESMAN_SYNC_TUNING.requestRetryBaseDelayMs, 500);
});
