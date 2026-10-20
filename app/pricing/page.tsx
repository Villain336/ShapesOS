// ShapesOS — public pricing page (Phase 15.3: base fee + seats + credits).
// A public PAGE, not an API route: it reads no database and no session, and
// renders straight from the plan constants (lib/billing/plans.ts
// pricingPageData — prices there, seats/limits in entitlements.ts, credit
// pools in metering/credits.ts). No number is typed on this page.

import Link from "next/link";
import { ArrowRight, Check, KeyRound } from "lucide-react";
import { PricingTable } from "@/components/billing/PricingTable";
import { pricingPageData } from "@/lib/billing/plans";

export const metadata = {
  title: "Pricing — ShapesOS",
  description:
    "ShapesOS pricing: a base fee with seats and AI credits included. Starter, Pro, Business and Agency plans, a free trial, and free self-hosting.",
};

const quietNav =
  "inline-flex h-control-sm items-center rounded-full px-4 text-base font-semibold text-muted transition-colors hover:bg-hover hover:text-ink";
const primaryCta =
  "aos-press inline-flex h-control items-center gap-2 rounded-full bg-ink px-5.5 text-base font-semibold text-white hover:bg-ink-hover";

export default function PricingPage() {
  const data = pricingPageData();
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-xl font-heading stretch-heading text-ink">
            ShapesOS
          </Link>
          <nav aria-label="Site" className="flex items-center gap-2">
            <Link href="/pricing" aria-current="page" className={quietNav}>
              Pricing
            </Link>
            <Link href="/login" className={quietNav}>
              Sign in
            </Link>
            <Link href="/signup" className={primaryCta}>
              Start free trial
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-6 pb-10 pt-16 text-center">
          <h1 className="aos-display mx-auto max-w-3xl">Simple pricing: a base fee, seats and AI credits</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted">
            Every plan includes seats and a monthly pool of AI credits. Add seats as your team grows — you
            confirm every extra seat before it&apos;s billed.
          </p>
        </section>

        <section aria-label="Plans" className="mx-auto max-w-6xl px-6 pb-16">
          <PricingTable data={data} />
        </section>

        <section aria-labelledby="credits-heading" className="border-t border-line">
          <div className="mx-auto grid max-w-6xl gap-8 px-6 py-14 md:grid-cols-2">
            <div>
              <h2 id="credits-heading" className="aos-heading">
                What credits buy
              </h2>
              <p className="mt-2 text-sm text-muted">
                {data.creditValueDisplay}. Included credits are pre-paid usage for data, AI and messaging.
              </p>
              <table className="mt-4 w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs font-semibold text-muted">
                    <th scope="col" className="py-2 pr-3 font-semibold">Action</th>
                    <th scope="col" className="py-2 font-semibold">Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {data.creditExamples.map((e) => (
                    <tr key={e.label} className="border-b border-line last:border-0">
                      <th scope="row" className="py-2 pr-3 font-medium text-ink">{e.label}</th>
                      <td className="py-2 text-ink">{e.credits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h2 className="aos-heading">Top-ups and overage</h2>
              <ul className="mt-4 flex flex-col gap-2 text-sm text-ink">
                {data.topUps.map((t) => (
                  <li key={t.priceDisplay} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {t.priceDisplay} buys {t.credits.toLocaleString("en-US")} credits (they roll over for 12 months)
                  </li>
                ))}
                <li className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
                  Optional overage at {data.overagePerCreditDisplay} per credit — off by default, with a hard cap
                </li>
              </ul>
              <div className="mt-6 flex items-start gap-3 rounded-lg bg-paper p-4 shadow-hairline">
                <KeyRound className="mt-0.5 size-5 shrink-0 text-ink" aria-hidden />
                <p className="text-sm text-muted">
                  <span className="font-semibold text-ink">Bring your own key — coming soon.</span> A hosted
                  workspace that adds its own model provider key will pay no AI credits for those calls, on any
                  plan. Self-hosted ShapesOS already runs on your own keys.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5 text-xs text-muted">
          <span>ShapesOS — prices in USD, before tax</span>
          <Link href="/login" className="hover:text-ink">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
