import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Check,
  Code2,
  Mail,
  PenTool,
  Search,
  Share2,
} from "lucide-react";

export const metadata = {
  title: "Marketr — open-source marketing & SEO workspace",
  description:
    "Marketr is the open-source marketing and SEO workspace: keyword research, competitor gaps, content engine, and rank tracking.",
};

const primaryCta =
  "inline-flex items-center gap-2 rounded-md bg-violet-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-violet-700";
const secondaryCta =
  "inline-flex items-center gap-2 rounded-md border border-stone-300 bg-white px-5 py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-50";

const highlights = [
  {
    icon: Search,
    title: "Keyword research",
    body: "Keyword research and competitor gap analysis per project, wired straight into your content plan.",
    href: "/dashboard",
  },
  {
    icon: PenTool,
    title: "Canvas editor",
    body: "Design creatives, mockups, charts, and QR assets on a full canvas editor with SVG export.",
    href: "/dashboard/studio",
  },
  {
    icon: Bot,
    title: "Automations",
    body: "Growth missions and scheduled automations that keep SEO and content work running on autopilot.",
    href: "/dashboard/missions",
  },
  {
    icon: Share2,
    title: "Social publishing",
    body: "Compose, schedule, and publish posts across social channels from one workspace.",
    href: "/dashboard/social",
  },
  {
    icon: Mail,
    title: "Email publishing",
    body: "Approval-gated nurture sequences and newsletter broadcasts through a built-in email sidecar.",
    href: "/dashboard/nurture",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-[#FAFAF7] text-stone-900">
      {/* Top bar */}
      <header className="border-b border-stone-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="text-xl font-bold tracking-tight text-stone-900">
            Marketr
          </span>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm font-medium text-stone-600 hover:text-stone-900"
            >
              Sign in
            </Link>
            <Link href="/login" className={primaryCta}>
              Get started
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-6 pb-16 pt-20 text-center md:pt-24">
          <p className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-1.5 text-xs uppercase tracking-widest text-stone-500">
            <Code2 className="h-3.5 w-3.5" />
            Open source &middot; AGPLv3
          </p>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-bold tracking-tight text-stone-900 md:text-5xl">
            The open-source marketing &amp; SEO workspace
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-stone-500">
            Keyword research, competitor gap analysis, an AI content engine,
            rank tracking, site audits, and white-label client reporting in
            one self-serve OS.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link href="/login" className={primaryCta}>
              Get started
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/dashboard" className={secondaryCta}>
              Explore the dashboard
            </Link>
          </div>
        </section>

        {/* Capability highlights */}
        <section className="mx-auto max-w-6xl px-6 pb-20">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {highlights.map((h) => (
              <Link
                key={h.title}
                href={h.href}
                className="group rounded-lg border border-stone-200 bg-white p-5 hover:border-violet-300 hover:bg-violet-50/40"
              >
                <h.icon className="h-5 w-5 text-violet-600" />
                <h2 className="mt-3 text-base font-semibold tracking-tight text-stone-900">
                  {h.title}
                </h2>
                <p className="mt-1.5 text-[13px] leading-6 text-stone-500">
                  {h.body}
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-violet-700">
                  Open in Marketr
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
            {/* Self-host card completes the grid */}
            <Link
              href="/login"
              className="group rounded-lg border border-stone-200 bg-white p-5 hover:border-violet-300 hover:bg-violet-50/40"
            >
              <Code2 className="h-5 w-5 text-violet-600" />
              <h2 className="mt-3 text-base font-semibold tracking-tight text-stone-900">
                Self-hosted or hosted
              </h2>
              <p className="mt-1.5 text-[13px] leading-6 text-stone-500">
                Self-host it free with your own API keys, or pay for hosted
                with data included. Your data stays yours either way.
              </p>
              <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-violet-700">
                Sign in
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </div>
        </section>

        {/* Bottom CTA */}
        <section className="border-t border-stone-200">
          <div className="mx-auto max-w-6xl px-6 py-16 text-center">
            <h2 className="text-2xl font-bold tracking-tight text-stone-900">
              Ready to run your marketing from one place?
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-[13px] leading-6 text-stone-500">
              Bring your own DataForSEO and LLM keys — or start on hosted and
              switch later.
            </p>
            <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px] text-stone-600">
              {["AGPLv3 open source", "BYO API keys", "White-label reporting"].map(
                (t) => (
                  <li key={t} className="inline-flex items-center gap-1.5">
                    <Check className="h-4 w-4 text-violet-600" />
                    {t}
                  </li>
                )
              )}
            </ul>
            <div className="mt-8">
              <Link href="/login" className={primaryCta}>
                Sign in to Marketr
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-stone-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5 text-xs text-stone-500">
          <span>Marketr — open-source marketing &amp; SEO workspace</span>
          <Link href="/login" className="hover:text-stone-900">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
