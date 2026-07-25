import Link from "next/link";
import { LEGAL, legalDetailsIncomplete } from "@/lib/legal";

/**
 * Shared chrome for the two public legal pages. They are the only pages on this
 * origin an outsider is meant to read — Apple links the privacy policy from the
 * App Store listing and rejects a dead link — so they get plain, readable
 * typography and none of the admin portal's chrome.
 */
export function LegalShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-[68ch] px-6 py-14 sm:py-20">
      <header className="mb-10">
        <Link
          href="/"
          className="text-[13px] font-semibold tracking-wide text-accent-deep hover:underline"
        >
          Emberly
        </Link>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-primary sm:text-4xl">{title}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-text/70">{intro}</p>
        <p className="mt-4 text-[13px] text-text/50">
          Last updated{" "}
          <time dateTime={LEGAL.lastUpdated}>
            {new Date(`${LEGAL.lastUpdated}T00:00:00Z`).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            })}
          </time>
        </p>
      </header>

      {/* Impossible to publish a policy full of placeholders without noticing. */}
      {legalDetailsIncomplete() ? (
        <div
          role="alert"
          className="mb-10 rounded-lg border-2 border-dashed border-[#B4453A] bg-[#B4453A]/5 px-5 py-4"
        >
          <p className="text-[14px] font-bold text-[#B4453A]">Draft — not ready to publish</p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-text/75">
            This page still contains placeholder details (legal entity, contact addresses,
            retention period). Fill them in at <code className="font-mono">lib/legal.ts</code> and
            have the wording reviewed by a lawyer before linking it from the App Store.
          </p>
        </div>
      ) : null}

      <div className="space-y-9">{children}</div>

      <footer className="mt-16 border-t border-text/10 pt-6 text-[13px] text-text/55">
        <p>
          {LEGAL.legalEntity} · {LEGAL.postalAddress}
        </p>
        <p className="mt-2 flex gap-4">
          <Link href="/privacy" className="hover:underline">
            Privacy
          </Link>
          <Link href="/support" className="hover:underline">
            Support
          </Link>
        </p>
      </footer>
    </main>
  );
}

/** A titled section. `id` so the policy can be deep-linked in correspondence. */
export function Section({
  id,
  heading,
  children,
}: {
  id: string;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8">
      <h2 className="text-[19px] font-bold tracking-tight text-primary">{heading}</h2>
      <div className="mt-2.5 space-y-3 text-[15px] leading-relaxed text-text/80">{children}</div>
    </section>
  );
}
