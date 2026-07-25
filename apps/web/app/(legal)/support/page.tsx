import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell, Section } from "../_components/legal-shell";
import { LEGAL } from "@/lib/legal";

/**
 * Public support page. App Store Connect requires a support URL and, like the
 * privacy policy, it has to resolve without a session.
 *
 * Written for the two audiences who will actually arrive here: a technician
 * whose app is misbehaving, and an App Review engineer checking the link is
 * real. Deliberately short — a support page that buries the contact route is
 * worse than no support page.
 */
export const metadata: Metadata = {
  title: "Support",
  description: "Help for staff using the Emberly apps.",
  robots: { index: true, follow: true },
};

export default function SupportPage() {
  return (
    <LegalShell
      title="Support"
      intro="Emberly's apps are issued by your employer for property management work. If something isn't working, start here."
    >
      <Section id="account" heading="Can't sign in">
        <p>
          Accounts are not created here. You sign in with the property management credentials your
          employer issued — the same ones you use for the management system itself. If they are not
          working, or you need access to an app you don&apos;t have, ask your property manager or
          office administrator. We cannot create, reset or unlock accounts on request.
        </p>
      </Section>

      <Section id="common" heading="Common problems">
        <ul className="ml-5 list-disc space-y-2.5">
          <li>
            <strong>Work orders look out of date.</strong> The apps sync automatically in the
            background. Open Settings to see when data last arrived, and use Sync Now to force a
            refresh. If the timestamp stays old, the connection to the management system may be down
            — tell the office.
          </li>
          <li>
            <strong>Emergency alerts aren&apos;t arriving.</strong> Check the Emergency Alerts toggle
            in Settings. If turning it on shows a message, follow it — it will say whether
            notifications are blocked on the device or whether the app build cannot receive them.
          </li>
          <li>
            <strong>Work I recorded offline hasn&apos;t appeared.</strong> Nothing is lost. Closes,
            notes and photos taken without signal are queued on the device and sent when it
            reconnects. Settings shows what is still waiting.
          </li>
          <li>
            <strong>Spanish text still shows in English.</strong> Translation needs the iOS language
            pack installed. Switching the language in Settings will tell you if something is missing.
          </li>
        </ul>
      </Section>

      <Section id="contact" heading="Contact us">
        <p>
          For anything the above doesn&apos;t cover, including problems with the app itself, email:
        </p>
        <p className="font-medium">
          <a href={`mailto:${LEGAL.supportEmail}`} className="text-accent-deep hover:underline">
            {LEGAL.supportEmail}
          </a>
        </p>
        <p>
          It helps to include which app and device you are using, what you expected, and what
          happened instead. Please do not include resident details, passwords or account numbers in
          an email.
        </p>
      </Section>

      <Section id="privacy" heading="Privacy">
        <p>
          What these apps do with resident and staff information is described in the{" "}
          <Link href="/privacy" className="text-accent-deep hover:underline">
            privacy policy
          </Link>
          . Requests about your own information go to{" "}
          <a href={`mailto:${LEGAL.privacyEmail}`} className="text-accent-deep hover:underline">
            {LEGAL.privacyEmail}
          </a>
          .
        </p>
      </Section>
    </LegalShell>
  );
}
