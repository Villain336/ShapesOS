// ShapesOS — Phase 12 (people): after registering
// (/events/[slug]/registered?k=<signed view token>). The signed token is the
// capability: it shows THAT registration's state and, once confirmed, its QR
// tickets (and the webinar link). "Confirmed" for a paid ticket appears only
// after Stripe's signed webhook recorded the payment — this page never marks
// anything paid. Not indexed.

import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { appBaseUrl } from "@/lib/workspace/invite-mail";
import { loadRegistrationView } from "@/lib/ops/events/catalog";
import { fmtPrice } from "@/lib/ops/store/view";
import { shopBtnSecondary, shopCard, shopChip } from "@/components/store/styles";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your registration", robots: { index: false, follow: false } };

export default async function RegisteredPage({ params, searchParams }: PageProps<"/events/[slug]/registered">) {
  const { slug } = await params;
  const sp = await searchParams;
  const token = typeof sp.k === "string" ? sp.k : "";
  const h = await headers();
  const origin = h.get("host") ? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}` : "";
  const view = token ? await loadRegistrationView(token, appBaseUrl(process.env, origin) ?? origin) : null;
  if (!view || view.event.slug !== slug) {
    return (
      <div className={`${shopCard} flex flex-col gap-3 p-8`}>
        <h1 className="aos-heading">We couldn't find that registration</h1>
        <p className="text-[15px] text-muted">If you just paid, your receipt from Stripe is the record of your purchase.</p>
      </div>
    );
  }
  const confirmed = view.status === "confirmed";
  return (
    <div className="flex flex-col gap-6">
      <div className={`${shopCard} flex flex-col gap-2 p-8`}>
        <h1 className="aos-heading">
          {confirmed ? "You're registered" : view.status === "pending" ? "We're confirming your payment" : "This registration isn't active"}
        </h1>
        <p className="text-[15px]">
          {view.event.title} · {view.quantity} × {view.ticketName}
          {view.amountCents > 0 ? ` · ${fmtPrice(view.amountCents, view.currency)}` : ""}
        </p>
        <p className="text-[15px] text-muted">
          {confirmed
            ? "Show the QR code at the door. Each ticket checks in once."
            : view.status === "pending"
              ? "Stripe is confirming your payment. Your tickets appear here once it arrives — refresh in a moment."
              : `This registration is ${view.status}. No tickets are valid for it.`}
        </p>
        {confirmed && view.event.webinarUrl ? (
          <p className="text-[15px]">
            Join online:{" "}
            <a className="font-semibold underline" href={view.event.webinarUrl} target="_blank" rel="noreferrer">
              {view.event.webinarUrl}
            </a>
          </p>
        ) : null}
      </div>
      {confirmed ? (
        <section className="grid gap-4 sm:grid-cols-2">
          {view.tickets.map((t) => (
            <div key={t.attendeeId} className={`${shopCard} flex flex-col items-center gap-3 p-6 text-center`}>
              <p className="font-semibold">{t.name}</p>
              {t.qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={t.qrDataUrl} alt={`QR ticket for ${t.name}`} width={240} height={240} className="h-60 w-60" />
              ) : null}
              {t.checkedInAt ? <span className={shopChip}>Checked in</span> : null}
              {t.url ? (
                <Link className="text-[13px] font-semibold underline" href={t.url.replace(/^https?:\/\/[^/]+/, "")}>
                  Open this ticket on its own
                </Link>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      <div>
        <Link href={`/events/${view.event.slug}`} className={shopBtnSecondary}>
          Back to the event
        </Link>
      </div>
    </div>
  );
}
