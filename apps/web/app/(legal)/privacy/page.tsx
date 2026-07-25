import type { Metadata } from "next";
import { LegalShell, Section } from "../_components/legal-shell";
import { LEGAL, PROCESSORS } from "@/lib/legal";

/**
 * Public privacy policy. Apple links this from the App Store listing and rejects
 * a dead or gated link, so it must stay reachable without a session — there is
 * no middleware on this app, and this route sits outside /admin deliberately.
 *
 * The root layout sets noindex site-wide to keep the admin portal out of search
 * results. Overridden here: a privacy policy is meant to be findable.
 *
 * Everything below describes what the code actually does. The processor list is
 * generated from lib/legal.ts, which was compiled by reading the source rather
 * than from memory. It is still a legal document and still needs a lawyer.
 */
export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Emberly handles resident and staff information.",
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <LegalShell
      title="Privacy Policy"
      intro="Emberly is a private platform used by property management staff. It is not a consumer product and has no public sign-up. This page explains what information it handles and why."
    >
      <Section id="roles" heading="Who is responsible for your information">
        <p>
          Emberly is operated by {LEGAL.legalEntity} on behalf of the property management company
          that employs its users. That company decides what resident information exists and how long
          it is kept; Emberly processes it on their instructions.
        </p>
        <p>
          If you are a <strong>resident</strong> asking about your own information, your property
          manager is the right first contact — they hold the records. We will help them respond.
        </p>
      </Section>

      <Section id="staff" heading="Information about staff who use the apps">
        <p>Signing in with property management credentials records:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>your name, staff account identifier and role</li>
          <li>an access token stored in the device keychain, so you stay signed in</li>
          <li>a notification token, if you turn on emergency alerts</li>
          <li>which actions you took — closing a work order, revealing a resident detail</li>
        </ul>
        <p>
          Your password is exchanged for a token at sign-in and is <strong>never stored</strong> on
          the device or by us. Signing out deletes the token and clears cached records from the
          device.
        </p>
      </Section>

      <Section id="residents" heading="Information about residents">
        <p>
          Staff apps display resident records drawn from the property management system: name, unit,
          phone, email, vehicles and licence plates, lease terms, account balances and payment
          history, utility accounts, and work orders relating to the home.
        </p>
        <p>
          <strong>Date of birth, driver&apos;s licence and income are treated differently.</strong>{" "}
          They are hidden by default, are not included in the data cached on a device, and are only
          retrieved when a manager explicitly reveals a single field. Every reveal is recorded with
          who did it and when.
        </p>
        <p>
          Work orders contain descriptions, technician notes and photographs of the work, which may
          show the inside of a home.
        </p>
      </Section>

      <Section id="not-collected" heading="What we do not do">
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong>No location tracking.</strong> The apps do not request or record device location.
          </li>
          <li>
            <strong>No advertising, and no data brokers.</strong> Nothing is sold or shared for
            advertising or any other unrelated purpose.
          </li>
          <li>
            <strong>No consumer accounts.</strong> There is no public sign-up; access is issued by an
            employer.
          </li>
          <li>
            <strong>Voice notes stay on the device.</strong> Dictation is transcribed by iOS on the
            device itself. Audio is not uploaded to us or anyone else.
          </li>
        </ul>
      </Section>

      <Section id="processors" heading="Who else receives information">
        <p>
          Emberly relies on the services below. Each receives only what its job requires, and none is
          permitted to use it for their own purposes.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-text/15 text-left">
                <th className="py-2 pr-4 font-semibold text-primary">Service</th>
                <th className="py-2 pr-4 font-semibold text-primary">Purpose</th>
                <th className="py-2 font-semibold text-primary">What it receives</th>
              </tr>
            </thead>
            <tbody>
              {PROCESSORS.map((p) => (
                <tr key={p.name} className="border-b border-text/10 align-top">
                  <td className="py-2.5 pr-4 font-medium">{p.name}</td>
                  <td className="py-2.5 pr-4 text-text/70">{p.purpose}</td>
                  <td className="py-2.5 text-text/70">{p.data}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4">
          Translation deserves a specific note: to show work orders to Spanish-speaking technicians,
          work-order titles, descriptions and technician notes are sent to a translation service.
          That text can describe a resident&apos;s home and may include their name.
        </p>
      </Section>

      <Section id="retention" heading="How long information is kept">
        <p>{LEGAL.retentionSummary}</p>
        <p>
          Records that exist for accountability — such as the log of who revealed a resident detail —
          are kept for the full retention period even after the underlying record changes.
        </p>
      </Section>

      <Section id="security" heading="How it is protected">
        <ul className="ml-5 list-disc space-y-1.5">
          <li>encrypted in transit, and at rest by the hosting provider</li>
          <li>access tokens held in the device keychain, never in ordinary app storage</li>
          <li>
            each app credential limited to the data that app needs — a maintenance device cannot
            reach financial or resident-roster records
          </li>
          <li>
            gate scanner devices restricted further still, and unable to reach resident records or
            work-order photographs
          </li>
          <li>cached records removed from a device when a user signs out or a device is retired</li>
        </ul>
      </Section>

      <Section id="rights" heading="Requests about your information">
        <p>
          Depending on where you live, you may have the right to ask what information is held about
          you, to have it corrected, or to have it deleted. Residents should contact their property
          manager first. You can also write to us and we will route the request:
        </p>
        <p className="font-medium">
          <a href={`mailto:${LEGAL.privacyEmail}`} className="text-accent-deep hover:underline">
            {LEGAL.privacyEmail}
          </a>
          <br />
          <span className="font-normal text-text/70">{LEGAL.postalAddress}</span>
        </p>
      </Section>

      <Section id="children" heading="Children">
        <p>
          The apps are work tools for employees and are not directed at children. We do not knowingly
          collect information from anyone under 13 through them. Resident records may name minors in
          a household because a lease does; that information comes from the property manager and is
          handled the same as any other resident record.
        </p>
      </Section>

      <Section id="changes" heading="Changes">
        <p>
          If this policy changes materially we will update the date at the top and notify the
          property management company. Continued use after a change means the current version
          applies.
        </p>
      </Section>
    </LegalShell>
  );
}
