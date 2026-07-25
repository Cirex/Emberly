/**
 * Facts the public legal pages are built from.
 *
 * ⚠️ TWO THINGS BEFORE THIS GOES LIVE
 *
 * 1. The FILL_IN values below are placeholders. A privacy policy that names no
 *    legal entity and gives no contact route is not compliant, and Apple checks
 *    that the link resolves to a real policy.
 * 2. This was written to be factually accurate about what the code actually
 *    does — every processor listed was read out of the source, not assumed —
 *    but it has NOT been reviewed by a lawyer. Data-protection obligations turn
 *    on who the controller is, which jurisdictions your residents are in, and
 *    what your management agreements already promise. Get it reviewed.
 *
 * Kept as data rather than prose in JSX so the two pages cannot drift apart and
 * so the processor list stays reviewable as a list.
 */

/** Replace every one of these. Grep for FILL_IN to find what is outstanding. */
const FILL_IN = {
  /** The company that operates the platform and answers privacy requests. */
  legalEntity: "FILL_IN — registered company name",
  /** Where privacy requests should be sent. A monitored mailbox, not a person. */
  privacyEmail: "FILL_IN — privacy@yourdomain",
  /** Where staff go when the app misbehaves. */
  supportEmail: "FILL_IN — support@yourdomain",
  /** Postal address. Required by several privacy regimes. */
  postalAddress: "FILL_IN — postal address",
  /**
   * How long operational records are kept. Deliberately not invented — this is a
   * policy decision with legal consequences, and the code does not encode one.
   */
  retentionSummary: "FILL_IN — retention period for work orders, photos and audit logs",
} as const;

export const LEGAL = {
  ...FILL_IN,
  /** Matches packages/core PRODUCTION_ORIGIN. */
  origin: "https://emberly.krkn.app",
  /** ISO date shown as "last updated". Bump when the policy changes. */
  lastUpdated: "2026-07-25",
} as const;

/** True while any placeholder survives — the pages surface a warning banner. */
export function legalDetailsIncomplete(): boolean {
  return Object.values(FILL_IN).some((v) => v.startsWith("FILL_IN"));
}

export interface Processor {
  name: string;
  purpose: string;
  /** What actually reaches them. Specific — "usage data" tells a reader nothing. */
  data: string;
}

/**
 * Third parties that receive data, read out of the codebase rather than
 * remembered:
 *   Supabase   apps/web/lib/supabase — every resman_ and mlgw_ table, plus storage
 *   ResMan     supabase/sync/src/resman — the source of record
 *   MLGW       supabase/sync/src/mlgw — utility billing
 *   Langbly    supabase/sync/src/shared/langbly.ts — receives work-order
 *              title/notes/completion_notes, which routinely describe the inside
 *              of a resident's home and can name them
 *   PostHog    each app's lib/analytics.ts — events keyed to a staff id + role
 *   Sentry     each app's lib/sentry.ts — crash diagnostics
 *   Expo/Apple each app's lib/push.ts — push delivery
 */
export const PROCESSORS: readonly Processor[] = [
  {
    name: "Supabase",
    purpose: "Database and file storage for the platform",
    data: "All records described above, including work-order photos",
  },
  {
    name: "Vercel",
    purpose: "Hosting for the web portal and its API",
    data: "Request logs and anything submitted through the portal",
  },
  {
    name: "ResMan",
    purpose: "The property management system of record",
    data: "Resident, lease, unit and work-order records originate here",
  },
  {
    name: "Memphis Light, Gas and Water (MLGW)",
    purpose: "Utility account and billing reconciliation",
    data: "Utility account numbers, service addresses, bills and payments",
  },
  {
    name: "Langbly",
    purpose: "Translating work-order text for Spanish-speaking technicians",
    data: "Work-order titles, descriptions and technician notes",
  },
  {
    name: "PostHog",
    purpose: "Product analytics — which features staff use, and what fails",
    data: "App events with a staff account identifier and role. No resident details",
  },
  {
    name: "Sentry",
    purpose: "Crash and error diagnostics",
    data: "Crash reports, device model and OS version",
  },
  {
    name: "Apple / Expo",
    purpose: "Delivering push notifications to staff devices",
    data: "A device push token and the notification content",
  },
] as const;
