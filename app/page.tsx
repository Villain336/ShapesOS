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
  title: "ShapesOS — open-source marketing & SEO workspace",
  description:
    "ShapesOS is the open-source marketing and SEO workspace: keyword research, competitor gaps, content engine, and rank tracking.",
};

const primaryCta =
  "aos-press inline-flex h-control items-center gap-2 rounded-full bg-ink px-5.5 text-base font-semibold text-white hover:bg-ink-hover";
const secondaryCta =
  "aos-press inline-flex h-control items-center gap-2 rounded-full bg-paper px-5.5 text-base font-semibold text-ink shadow-outline";
const quietNav =
  "inline-flex h-control-sm items-center rounded-full px-4 text-base font-semibold text-muted transition-colors hover:bg-hover hover:text-ink";

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
    <div className="min-h-screen bg-canvas">
      {/* Top bar */}
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="text-xl font-heading stretch-heading text-ink">
            ShapesOS
          </span>
          <div className="flex items-center gap-2">
            {/* Phase 15.3: public pricing page (rendered from the plan constants). */}
            <Link href="/pricing" className={quietNav}>
              Pricing
            </Link>
            <Link href="/login" className={quietNav}>
              Sign in
            </Link>
            <Link href="/login" className={primaryCta}>
              Get started
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-6 pb-16 pt-20 text-center md:pt-24">
          <p className="inline-flex h-chip items-center gap-2 rounded-full bg-paper px-4 text-sm font-semibold text-muted shadow-control">
            <Code2 className="size-3.5" />
            Open source &middot; AGPLv3
          </p>
          <h1 className="aos-display mx-auto mt-6 max-w-3xl">
            The open-source marketing &amp; SEO workspace
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted">
            Keyword research, competitor gap analysis, an AI content engine,
            rank tracking, site audits, and white-label client reporting in
            one self-serve OS.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/login" className={primaryCta}>
              Get started
              <ArrowRight className="size-4" />
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
                className="group rounded-lg bg-paper p-5 shadow-hairline transition-colors hover:bg-hover-paper"
              >
                <h.icon className="size-5 text-ink" />
                <h2 className="mt-3 text-base font-semibold text-ink">
                  {h.title}
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">
                  {h.body}
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-ink">
                  Open in ShapesOS
                  <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
            {/* Self-host card completes the grid */}
            <Link
              href="/login"
              className="group rounded-lg bg-paper p-5 shadow-hairline transition-colors hover:bg-hover-paper"
            >
              <Code2 className="size-5 text-ink" />
              <h2 className="mt-3 text-base font-semibold text-ink">
                Self-hosted or hosted
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                Self-host it free with your own API keys, or pay for hosted
                with data included. Your data stays yours either way.
              </p>
              <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-ink">
                Sign in
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </div>
        </section>

        {/* Bottom CTA */}
        <section className="border-t border-line">
          <div className="mx-auto max-w-6xl px-6 py-16 text-center">
            <h2 className="aos-heading">
              Ready to run your marketing from one place?
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Bring your own DataForSEO and LLM keys — or start on hosted and
              switch later.
            </p>
            <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted">
              {["AGPLv3 open source", "BYO API keys", "White-label reporting"].map(
                (t) => (
                  <li key={t} className="inline-flex items-center gap-1.5">
                    <Check className="size-4 text-ink" />
                    {t}
                  </li>
                )
              )}
            </ul>
            <div className="mt-8">
              <Link href="/login" className={primaryCta}>
                Sign in to ShapesOS
                <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5 text-xs text-muted">
          <span>ShapesOS — open-source marketing &amp; SEO workspace</span>
          <Link href="/login" className="hover:text-ink">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
