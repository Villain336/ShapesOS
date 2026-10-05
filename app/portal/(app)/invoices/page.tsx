// ShapesOS — Phase 10 (portal): /portal/invoices — issued invoices and credit
// notes linked to this client: PDF download (finance PDF) and, when the
// agency has connected Stripe, "Pay now" (tenant Stripe Checkout).

import { Download } from "lucide-react";
import { portalPage } from "@/lib/portal/page";
import { portalCan } from "@/lib/portal/core";
import { listPortalInvoices } from "@/lib/portal/data";
import { fmtMoney } from "@/lib/ops/finance/money";
import { PayInvoiceButton } from "@/components/portal/PortalActions";
import { btnQuietSm, chipCls, emptyCls, fmtDate, noteCls, pageHintCls, pageTitleCls, rowCls, stateLabel, tableCls, tableWrapCls, tdCls, thCls } from "@/components/portal/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invoices — Client portal" };

export default async function PortalInvoices({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const p = await portalPage("invoices");
  const { invoices, currency } = await listPortalInvoices(p);
  const paid = (await searchParams).paid;
  const canPay = portalCan(p.role, "invoice_pay");
  return (
    <>
      <div>
        <h1 className={pageTitleCls}>Invoices</h1>
        <p className={pageHintCls}>Invoices and credit notes from {p.workspaceName}. Download any of them as a PDF.</p>
      </div>
      {typeof paid === "string" && (
        <div role="status" className={noteCls}>
          Thanks. Your payment for {paid.slice(0, 40)} is being processed; the invoice shows as paid once it clears.
        </div>
      )}
      {invoices.length === 0 ? (
        <div className={emptyCls}>No invoices yet.</div>
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Number</th>
                <th className={thCls}>Issued</th>
                <th className={thCls}>Due</th>
                <th className={thCls}>State</th>
                <th className={`${thCls} text-right`}>Total</th>
                <th className={`${thCls} text-right`}>Balance</th>
                <th className={`${thCls} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id} className={rowCls}>
                  <td className={tdCls}>
                    <span className="font-semibold">{i.number ?? "Invoice"}</span>
                    {i.kind === "credit_note" && <span className="ml-2 text-sm text-muted">Credit note</span>}
                  </td>
                  <td className={tdCls}>{fmtDate(i.sentAt)}</td>
                  <td className={tdCls}>{i.kind === "invoice" ? fmtDate(i.dueAt) : "—"}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{stateLabel(i.status)}</span>
                  </td>
                  <td className={`${tdCls} text-right tabular-nums`}>{fmtMoney(i.totalCents, currency)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{i.kind === "invoice" ? fmtMoney(i.balanceCents, currency) : "—"}</td>
                  <td className={`${tdCls} text-right`}>
                    <span className="inline-flex items-start justify-end gap-2">
                      <a className={btnQuietSm} href={`/api/portal/invoices/${encodeURIComponent(i.id)}/pdf`}>
                        <Download size={15} aria-hidden /> PDF
                      </a>
                      {i.payable && canPay && <PayInvoiceButton invoiceId={i.id} />}
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
