// ShapesOS — public pricing table (Phase 15.3). Client component only for
// the monthly / annual toggle; every number arrives in `data`, built by
// lib/billing/plans.ts pricingPageData() from the plan constants, so the
// page never types a price, seat count or credit pool itself.
// Agentic OS: white cards with hairline shadow on canvas, black primary
// action, pill segmented control, Lucide icons, no status colours.

"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import type { PricingPageData } from "@/lib/billing/plans";

type Interval = "month" | "year";

const usd = (cents: number) =>
  `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

const primaryCta =
  "aos-press inline-flex h-control w-full items-center justify-center gap-2 rounded-full bg-ink px-5.5 text-base font-semibold text-white hover:bg-ink-hover";
const secondaryCta =
  "aos-press inline-flex h-control w-full items-center justify-center gap-2 rounded-full bg-paper px-5.5 text-base font-semibold text-ink shadow-outline";
const segBase = "aos-press inline-flex h-control-sm items-center rounded-full px-4 text-sm font-semibold";

export function PricingTable({ data }: { data: PricingPageData }) {
  const [interval, setBillingInterval] = useState<Interval>("month");
  const freeMonths = 12 - data.annualBilledMonths;

  return (
    <div>
      <div className="flex justify-center">
        <div role="group" aria-label="Billing interval" className="inline-flex gap-1 rounded-full bg-paper p-1 shadow-control">
          {(["month", "year"] as const).map((i) => (
            <button
              key={i}
              type="button"
              aria-pressed={interval === i}
              onClick={() => setBillingInterval(i)}
              className={`${segBase} ${interval === i ? "bg-ink text-white" : "text-ink hover:bg-hover"}`}
            >
              {i === "month" ? "Monthly" : `Annual, ${freeMonths} months free`}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.paid.map((p) => {
          const price = interval === "year" ? p.annualCents : p.monthlyCents;
          return (
            <section
              key={p.id}
              aria-labelledby={`plan-${p.id}`}
              data-plan={p.id}
              className={`relative flex flex-col rounded-lg bg-paper p-5 ${p.badge ? "shadow-outline" : "shadow-hairline"}`}
            >
              {p.badge && (
                <span className="absolute -top-3 left-5 inline-flex h-6 items-center rounded-full bg-ink px-3 text-xs font-semibold text-white">
                  {p.badge}
                </span>
              )}
              <h2 id={`plan-${p.id}`} className="aos-subheading">
                {p.name}
              </h2>
              <p className="mt-1 text-sm text-muted">{p.tagline}</p>
              <p className="mt-4">
                <span className="text-[2rem] font-heading stretch-heading text-ink">{price === null ? "" : usd(price)}</span>
                <span className="text-sm text-muted"> / {interval === "year" ? "year" : "month"}</span>
              </p>
              <p className="mt-1 min-h-5 text-[0.8125rem] text-muted">
                {interval === "year" && p.annualMonthlyEquivalentCents !== null
                  ? `${usd(p.annualMonthlyEquivalentCents)} / month, billed yearly`
                  : `or ${usd(p.annualCents ?? 0)} / year`}
              </p>
              <ul className="mt-5 flex flex-1 flex-col gap-2">
                {p.lines.map((line) => (
                  <li key={line} className="flex items-start gap-2 text-sm text-ink">
                    <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
              <Link href="/signup" className={`${p.badge ? primaryCta : secondaryCta} mt-6`}>
                Start with a free trial
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </section>
          );
        })}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {[data.trial, data.selfHosted].map((p) => (
          <section key={p.id} aria-labelledby={`plan-${p.id}`} data-plan={p.id} className="rounded-lg bg-paper p-5 shadow-hairline">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id={`plan-${p.id}`} className="aos-subheading">
                {p.name}
              </h2>
              <p className="text-base font-semibold text-ink">{p.priceNote}</p>
            </div>
            <p className="mt-1 text-sm text-muted">{p.tagline}</p>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {p.lines.map((line) => (
                <li key={line} className="flex items-start gap-2 text-sm text-ink">
                  <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {line}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
