/**
 * ResManConfiguration / ResManCompany — subdomain/account/company + derived
 * consumer/auth base URLs. Design §3.1.
 *
 * Built from ENV, not from the database. The Swift original read a
 * `resman_companies` row so one install could serve several ResMan accounts;
 * this deployment serves one, so the table was never queried and was dropped on
 * 2026-08-02 (deltas/2026-08-02-drop-resman-companies.sql).
 *
 * Ported from KrakenCore/Services/ResMan/ResManConfiguration.swift +
 * ResManCompany.swift. Also carries the request-tuning constants that the Swift
 * side kept in `ResManSyncTuning` (concurrency defaults; design §8 warns that
 * aggressive concurrency — 6×2 concurrent connections — caused ResMan error
 * pages, so the safe default is 6 sequential-within-worker connections).
 */

import { ENV, type EnvRecord } from "../config/env";

export interface ResManConfiguration {
  readonly subdomain: string;
  /** e.g. https://multisouth.myresman.com/ (trailing slash — used as a base URL). */
  readonly consumerStartUrl: string;
  /** e.g. https://multisouth.auth.myresman.com (no trailing slash). */
  readonly authBaseUrl: string;
  readonly accountId: string;
  readonly companyName: string;
}

/**
 * Builds a configuration from a subdomain, mirroring the failable Swift
 * initializer: it trims the subdomain, rejects empty/invalid hosts, and derives
 * the consumer + auth base URLs. Returns `null` when the subdomain cannot form a
 * valid host (the Swift `init?` returning nil).
 */
export function makeResManConfiguration(params: {
  subdomain: string;
  accountId: string;
  companyName: string;
}): ResManConfiguration | null {
  const trimmed = params.subdomain.trim();
  if (trimmed.length === 0) return null;

  const encoded = encodeURIComponent(trimmed);
  let consumerStartUrl: string;
  let authBaseUrl: string;
  try {
    consumerStartUrl = new URL(`https://${encoded}.myresman.com/`).toString();
    authBaseUrl = new URL(`https://${encoded}.auth.myresman.com`).toString().replace(/\/$/, "");
  } catch {
    return null;
  }

  return {
    subdomain: trimmed,
    consumerStartUrl,
    authBaseUrl,
    accountId: params.accountId,
    companyName: params.companyName,
  };
}

/** The default single-company configuration (design §1.1 — account 1659). */
export const MULTI_SOUTH_CONFIGURATION: ResManConfiguration = (() => {
  const config = makeResManConfiguration({
    subdomain: "multisouth",
    accountId: "1659",
    companyName: "The Multi-South Group",
  });
  if (!config) throw new Error("Failed to build the built-in Multi-South configuration");
  return config;
})();

/** Enumerated ResMan companies (port of the Swift `ResManCompany` enum). */
export const RESMAN_COMPANIES = {
  multiSouth: {
    id: "multi-south",
    displayName: "The Multi-South Group",
    subdomain: "multisouth",
    accountId: "1659",
  },
} as const;

export type ResManCompanyId = (typeof RESMAN_COMPANIES)[keyof typeof RESMAN_COMPANIES]["id"];

/**
 * Resolve a configuration from environment overrides (design §5.4). Falls back
 * to the built-in Multi-South configuration when the subdomain override is
 * absent or invalid. The account id override is applied on top.
 */
export function resManConfigurationFromEnv(
  env: EnvRecord = process.env,
): ResManConfiguration {
  const subdomain = env[ENV.RESMAN_SUBDOMAIN]?.trim();
  const accountId = env[ENV.RESMAN_ACCOUNT_ID]?.trim() || MULTI_SOUTH_CONFIGURATION.accountId;

  if (subdomain) {
    const config = makeResManConfiguration({
      subdomain,
      accountId,
      companyName: MULTI_SOUTH_CONFIGURATION.companyName,
    });
    if (config) return config;
  }

  if (accountId === MULTI_SOUTH_CONFIGURATION.accountId) return MULTI_SOUTH_CONFIGURATION;
  return { ...MULTI_SOUTH_CONFIGURATION, accountId };
}

/** Injected ResMan staff credentials (design §5.4 — never hardcoded). */
export interface ResManCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Read the ResMan staff credentials from the environment (Coolify secrets).
 * Fails closed: throws if either variable is missing, so a misconfigured worker
 * never silently runs unauthenticated. The names come from `src/config/env.ts`.
 */
export function resManCredentialsFromEnv(env: EnvRecord = process.env): ResManCredentials {
  const username = env[ENV.RESMAN_SYNC_USERNAME]?.trim() ?? "";
  const password = env[ENV.RESMAN_SYNC_PASSWORD] ?? "";
  if (!username || !password) {
    throw new Error(
      `ResMan credentials not configured — set ${ENV.RESMAN_SYNC_USERNAME} and ` +
        `${ENV.RESMAN_SYNC_PASSWORD} in the worker's secret store (design §5.4).`,
    );
  }
  return { username, password };
}

/**
 * Request-scheduling tuning (port of `ResManSyncTuning`). The default of 6
 * connections-per-host, kept sequential within a worker, is the value the Swift
 * app shipped and the design (§8) flags as the safe ceiling — raising it caused
 * ResMan to return HTML error pages instead of data.
 */
export const RESMAN_SYNC_TUNING = {
  defaultConnectionsPerHost: 6,
  minimumConnectionsPerHost: 1,
  maximumConnectionsPerHost: 64,
  defaultSyncWorkers: 6,
  minimumSyncWorkers: 1,
  maximumSyncWorkers: 24,
  /**
   * Per-request retry (design §5.3). Wired into the scrape HTTP layer
   * (scrapers/http.ts `withResManRetries`) — transient network errors and
   * ResMan's under-load error page are retried with exponential backoff.
   */
  requestRetryAttempts: 3,
  requestRetryBaseDelayMs: 500,
} as const;
