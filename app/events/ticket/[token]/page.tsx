// ShapesOS — Phase 12 (people): one QR ticket (/events/ticket/<signed token>)
// — what the QR code itself points at. The signed token plus the stored
// ticket code are the capability; it shows the attendee's ticket state and
// the QR to scan. Scanning it at the door goes through the staff check-in
// screen, which marks the attendee once. Not indexed.

import type { Metadata } from "next";
import { headers } from "next/headers";
import { appBaseUrl } from "@/lib/workspace/invite-mail";
import { loadTicketByToken } from "@/lib/ops/events/catalog";
import { renderTicketQr, ticketUrl } from "@/lib/ops/events/tickets";
import { shopCard, shopChip } from "@/components/store/styles";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your ticket", robots: { index: false, follow: false } };

export default async function TicketPage({ params }: PageProps<"/events/ticket/[token]">) {
  const { token } = await params;
  const t = await loadTicketByToken(decodeURIComponent(token));
  if (!t) {
    return (
      <div className={`${shopCard} flex flex-col gap-3 p-8`}>
        <h1 className="aos-heading">This ticket isn't valid</h1>
        <p className="text-[0.9375rem] text-muted">Check the link from your registration page.</p>
      </div>
    );
  }
  const h = await headers();
  const origin = h.get("host") ? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}` : "";
  const url = ticketUrl(appBaseUrl(process.env, origin) ?? origin, decodeURIComponent(token));
  const confirmed = t.status === "confirmed";
  const qr = confirmed ? `data:image/png;base64,${renderTicketQr(url).png.toString("base64")}` : null;
  return (
    <div className={`${shopCard} mx-auto flex max-w-md flex-col items-center gap-3 p-8 text-center`}>
      <p className="text-[0.8125rem] font-semibold text-muted">{t.event.title}</p>
      <h1 className="aos-heading">{t.name}</h1>
      <p className="text-[0.9375rem] text-muted">{t.ticketType}</p>
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt={`QR ticket for ${t.name}`} width={260} height={260} className="h-[260px] w-[260px]" />
      ) : (
        <p className="text-[0.9375rem]">{t.status === "pending" ? "Payment for this ticket hasn't been confirmed yet." : `This ticket is ${t.status}.`}</p>
      )}
      {t.checkedInAt ? <span className={shopChip}>Checked in</span> : null}
      {confirmed && t.event.webinarUrl ? (
        <a className="text-[0.9375rem] font-semibold underline" href={t.event.webinarUrl} target="_blank" rel="noreferrer">
          Join online
        </a>
      ) : null}
    </div>
  );
}
