// ShapesOS — Phase 10 (portal): /portal/tickets — support tickets on this
// client's linked contacts, and (editor+ clients) a form to open one.

import Link from "next/link";
import { portalPage } from "@/lib/portal/page";
import { portalCan } from "@/lib/portal/core";
import { listPortalTickets } from "@/lib/portal/data";
import { NewTicketForm } from "@/components/portal/PortalActions";
import { cardCls, chipCls, emptyCls, fmtDate, linkCls, noteCls, pageHintCls, pageTitleCls, rowCls, stateLabel, tableCls, tableWrapCls, tdCls, thCls } from "@/components/portal/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tickets — Client portal" };

export default async function PortalTickets() {
  const p = await portalPage("tickets");
  const { tickets, canOpen } = await listPortalTickets(p);
  const canWrite = portalCan(p.role, "ticket_write");
  return (
    <>
      <div>
        <h1 className={pageTitleCls}>Tickets</h1>
        <p className={pageHintCls}>Questions and requests for {p.workspaceName}. Replies also arrive by email.</p>
      </div>
      {canWrite &&
        (canOpen ? (
          <section className={cardCls} aria-labelledby="new-ticket">
            <h2 id="new-ticket" className="aos-subheading">Open a ticket</h2>
            <div className="mt-3">
              <NewTicketForm />
            </div>
          </section>
        ) : (
          <div className={noteCls}>Your account isn&apos;t linked to a contact yet, so tickets can&apos;t be opened here. Email your account team instead.</div>
        ))}
      {tickets.length === 0 ? (
        <div className={emptyCls}>No tickets yet.</div>
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Ticket</th>
                <th className={thCls}>State</th>
                <th className={thCls}>Opened</th>
                <th className={thCls}>Last message</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id} className={rowCls}>
                  <td className={tdCls}>
                    <Link className={linkCls} href={`/portal/tickets/${encodeURIComponent(t.id)}`}>
                      <span className="aos-mono text-sm text-muted">#{t.number}</span> {t.subject}
                    </Link>
                  </td>
                  <td className={tdCls}>
                    <span className={chipCls}>{stateLabel(t.status)}</span>
                  </td>
                  <td className={tdCls}>{fmtDate(t.createdAt)}</td>
                  <td className={tdCls}>{fmtDate(t.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
