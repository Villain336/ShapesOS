// ShapesOS — Phase 10 (portal): /portal/quotes — quotes sent to this client:
// PDF download, and accept / decline (admin clients) through the quotes
// entity's status machine.

import { Download } from "lucide-react";
import { portalPage } from "@/lib/portal/page";
import { portalCan } from "@/lib/portal/core";
import { listPortalQuotes } from "@/lib/portal/data";
import { fmtMoney } from "@/lib/ops/finance/money";
import { QuoteDecisionButtons } from "@/components/portal/PortalActions";
import { btnQuietSm, chipCls, emptyCls, fmtDate, pageHintCls, pageTitleCls, rowCls, stateLabel, tableCls, tableWrapCls, tdCls, thCls } from "@/components/portal/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quotes — Client portal" };

export default async function PortalQuotes() {
  const p = await portalPage("quotes");
  const { quotes, currency } = await listPortalQuotes(p);
  const canDecide = portalCan(p.role, "quote_decide");
  return (
    <>
      <div>
        <h1 className={pageTitleCls}>Quotes</h1>
        <p className={pageHintCls}>
          {canDecide ? "Review a quote, then accept or decline it here." : "Quotes from your account team. Ask the person who manages your account to accept or decline them."}
        </p>
      </div>
      {quotes.length === 0 ? (
        <div className={emptyCls}>No quotes yet.</div>
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Number</th>
                <th className={thCls}>Sent</th>
                <th className={thCls}>Valid until</th>
                <th className={thCls}>State</th>
                <th className={`${thCls} text-right`}>Total</th>
                <th className={`${thCls} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id} className={rowCls}>
                  <td className={`${tdCls} font-semibold`}>{q.number ?? "Quote"}</td>
                  <td className={tdCls}>{fmtDate(q.sentAt)}</td>
                  <td className={tdCls}>{fmtDate(q.validUntil)}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{stateLabel(q.status, { quote: true })}</span>
                  </td>
                  <td className={`${tdCls} text-right tabular-nums`}>{fmtMoney(q.totalCents, currency)}</td>
                  <td className={`${tdCls} text-right`}>
                    <span className="inline-flex items-start justify-end gap-2">
                      <a className={btnQuietSm} href={`/api/portal/quotes/${encodeURIComponent(q.id)}/pdf`}>
                        <Download size={15} aria-hidden /> PDF
                      </a>
                      {q.decidable && canDecide && <QuoteDecisionButtons quoteId={q.id} />}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
