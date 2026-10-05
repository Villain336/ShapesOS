// ShapesOS — Phase 10 (portal): /portal/tickets/[id] — one ticket's thread
// (the client's messages and the team's replies; never internal notes) and,
// for editor+ clients, a reply form.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { portalPage } from "@/lib/portal/page";
import { portalCan } from "@/lib/portal/core";
import { getPortalTicket, PortalNotFoundError } from "@/lib/portal/data";
import { TicketReplyForm } from "@/components/portal/PortalActions";
import { btnQuietSm, cardCls, chipCls, fmtDate, noteCls, pageTitleCls, stateLabel } from "@/components/portal/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ticket — Client portal" };

export default async function PortalTicket({ params }: { params: Promise<{ id: string }> }) {
  const p = await portalPage("tickets");
  const t = await getPortalTicket(p, (await params).id).catch((e: unknown) => {
    if (e instanceof PortalNotFoundError) notFound();
    throw e;
  });
  const canWrite = portalCan(p.role, "ticket_write");
  return (
    <>
      <div className="flex flex-col gap-3">
        <Link href="/portal/tickets" className={`${btnQuietSm} self-start`}>
          <ArrowLeft size={15} aria-hidden /> All tickets
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className={pageTitleCls}>
            <span className="aos-mono text-muted">#{t.number}</span> {t.subject}
          </h1>
          <span className={chipCls}>{stateLabel(t.status)}</span>
        </div>
      </div>
      <ol className="flex flex-col gap-3">
        {t.messages.map((m) => (
          <li key={m.id} className={`${cardCls} ${m.fromClient ? "sm:ml-12" : "sm:mr-12"}`}>
            <div className="flex items-center justify-between gap-3 text-xs font-semibold text-muted">
              <span>{m.fromClient ? "You" : p.workspaceName}</span>
              <span>{fmtDate(m.createdAt)}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-md text-ink">{m.body}</p>
          </li>
        ))}
        {t.messages.length === 0 && <li className={noteCls}>No messages yet.</li>}
      </ol>
      {canWrite &&
        (t.status === "closed" ? (
          <div className={noteCls}>This ticket is closed. Open a new ticket to write again.</div>
        ) : (
          <section className={cardCls}>
            <TicketReplyForm ticketId={t.id} />
          </section>
        ))}
    </>
  );
}
