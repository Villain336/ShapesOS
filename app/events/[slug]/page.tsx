// ShapesOS — Phase 12 (people): the public event page /events/[slug] — when
// and where, the sessions, the ticket types with live availability, and the
// registration form. Only PUBLISHED events resolve (SELECT-only routing
// policy); everything is read under the event's workspace scope. The
// webinar link is never shown here — only on confirmed tickets.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarDays, MapPin, Video } from "lucide-react";
import { publicCaptchaConfig } from "@/lib/auth/captcha";
import { loadPublicEvent, resolvePublishedEvent } from "@/lib/ops/events/catalog";
import { fmtPrice } from "@/lib/ops/store/view";
import { shopCard, shopChip } from "@/components/store/styles";
import { RegisterForm } from "@/components/events/RegisterForm";

export const dynamic = "force-dynamic";

function when(start: Date, end: Date, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = { dateStyle: "full", timeStyle: "short", timeZone: tz };
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", opts);
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
  }
  const sameDay = start.toDateString() === end.toDateString();
  const endFmt = sameDay ? new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: fmt.resolvedOptions().timeZone }) : fmt;
  return `${fmt.format(start)} – ${endFmt.format(end)} (${fmt.resolvedOptions().timeZone})`;
}

export async function generateMetadata({ params }: PageProps<"/events/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const ev = await resolvePublishedEvent(slug);
  if (!ev) return { title: "Event not found", robots: { index: false, follow: false } };
  return { title: ev.title, description: ev.description?.slice(0, 160) ?? `Register for ${ev.title}.`, openGraph: { title: ev.title, type: "website" } };
}

export default async function EventPage({ params, searchParams }: PageProps<"/events/[slug]">) {
  const { slug } = await params;
  const sp = await searchParams;
  const ev = await resolvePublishedEvent(slug);
  if (!ev) notFound();
  const { sessions, tickets, paymentsReady } = await loadPublicEvent(ev);
  const left = ev.capacity != null ? Math.max(0, ev.capacity - ev.reservedCount) : null;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="aos-heading text-[2rem] leading-tight">{ev.title}</h1>
        <p className="flex items-center gap-2 text-[0.9375rem]">
          <CalendarDays size={16} aria-hidden /> {when(ev.startsAt, ev.endsAt, ev.timezone)}
        </p>
        {ev.venue ? (
          <p className="flex items-center gap-2 text-[0.9375rem]">
            <MapPin size={16} aria-hidden /> {ev.venue}
          </p>
        ) : null}
        {ev.hasWebinar ? (
          <p className="flex items-center gap-2 text-[0.9375rem]">
            <Video size={16} aria-hidden /> Online — the link is on your ticket
          </p>
        ) : null}
        {left !== null ? <span className={`${shopChip} self-start`}>{left === 0 ? "Sold out" : `${left} seat${left === 1 ? "" : "s"} left`}</span> : null}
      </header>
      {sp.cancelled ? <p className={`${shopCard} p-4 text-[0.9375rem]`}>Payment was cancelled, so nothing was charged. Your seats are released shortly — you can register again below.</p> : null}
      {ev.description ? <div className={`${shopCard} whitespace-pre-line p-6 text-[0.9375rem] leading-relaxed`}>{ev.description}</div> : null}
      {sessions.length ? (
        <section className={`${shopCard} p-6`}>
          <h2 className="aos-subheading mb-3">Sessions</h2>
          <ul className="flex flex-col gap-2">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-0 last:pb-0">
                <span className="font-semibold">{s.title}</span>
                <span className="text-[0.8125rem] text-muted">
                  {when(s.startsAt, s.endsAt, ev.timezone)}
                  {s.venue ? ` · ${s.venue}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className={`${shopCard} flex flex-col gap-4 p-6`}>
        <h2 className="aos-subheading">Register</h2>
        <ul className="flex flex-col gap-1 text-[0.9375rem]">
          {tickets.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <span className="font-semibold">{t.name}</span>
                {t.sessionTitle ? <span className="text-muted"> · {t.sessionTitle}</span> : null}
                {t.description ? <span className="block text-[0.8125rem] text-muted">{t.description}</span> : null}
              </span>
              <span className="tabular-nums">
                {t.priceCents > 0 ? fmtPrice(t.priceCents, ev.currency) : "Free"}
                {t.availability.state !== "on_sale" ? <span className={`${shopChip} ml-2`}>{t.availability.reason}</span> : t.availability.remaining !== null && t.availability.remaining <= 10 ? <span className={`${shopChip} ml-2`}>{t.availability.remaining} left</span> : null}
              </span>
            </li>
          ))}
        </ul>
        <RegisterForm
          slug={ev.slug}
          paymentsReady={paymentsReady}
          captcha={publicCaptchaConfig()}
          tickets={tickets.map((t) => ({
            id: t.id,
            name: t.name,
            priceLabel: t.priceCents > 0 ? fmtPrice(t.priceCents, ev.currency) : "Free",
            free: t.priceCents === 0,
            maxNow: t.availability.maxNow,
            stateLabel: t.availability.remaining !== null && t.availability.remaining <= 10 ? `${t.availability.remaining} left` : null,
          }))}
        />
      </section>
    </div>
  );
}
