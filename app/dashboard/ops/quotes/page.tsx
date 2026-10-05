// ShapesOS — Phase 10 (finance): /dashboard/ops/quotes — quotes and
// estimates: dense list with status, customer, validity and conversions.

import { FileSignature } from "lucide-react";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { resolveCustomerNames } from "@/lib/ops/invoices";
import { financePageActor } from "@/lib/ops/finance/page";
import { DataTable, Empty, FinanceHeader, Panel, Pill, cellCls, fmtDay, money, numCls, rowCls } from "@/components/ops-finance/kit";
import { NewQuoteButton, QuoteActions } from "@/components/ops-finance/QuotesClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quotes — ShapesOS", description: "Quotes and estimates that convert to invoices or orders." };

const STATUS: Record<string, string> = { draft: "Draft", sent: "Sent", accepted: "Accepted", declined: "Declined", expired: "Expired" };

export default async function QuotesPage() {
  const actor = await financePageActor();
  const { quotes, customers, rates } = await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const quotes = await tx.opsQuote.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" }, take: 200 });
    const customers = await resolveCustomerNames(tx, actor.workspaceId, quotes.map((q) => q.customerId ?? "").filter(Boolean));
    const rates = await tx.opsTaxRate.findMany({ where: { workspaceId: actor.workspaceId, active: true }, select: { id: true, name: true, rateBps: true }, orderBy: { name: "asc" } });
    return { quotes, customers, rates };
  });
  const nameOf = new Map(customers.map((c) => [c.id, c.company ? `${c.name} (${c.company})` : c.name]));
  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader
        title="Quotes"
        description="Price work before you invoice it. Sent quotes go out with a PDF; accepted ones convert to a draft invoice or order in one step."
        actions={actor.canEdit ? <NewQuoteButton rates={rates} /> : null}
      />
      <Panel>
        {quotes.length === 0 ? (
          <Empty icon={<FileSignature size={28} aria-hidden />} title="No quotes yet">
            Create one with New quote, or ask the assistant: “Draft a quote for Acme: 20 hours of design at $150.”
          </Empty>
        ) : (
          <DataTable head={[{ label: "Quote" }, { label: "Customer" }, { label: "State" }, { label: "Valid until" }, { label: "Total", align: "right" }, { label: "" }]}>
            {quotes.map((q) => {
              const label = q.number ?? `Draft quote ${q.id.slice(-6).toUpperCase()}`;
              return (
                <tr key={q.id} className={rowCls}>
                  <td className={`${cellCls} font-semibold`}>{label}</td>
                  <td className={`${cellCls} max-w-[260px] truncate`}>{q.customerId ? nameOf.get(q.customerId) ?? "Customer" : <span className="text-muted">No customer</span>}</td>
                  <td className={cellCls}>
                    <span className="flex flex-wrap gap-1.5">
                      <Pill>{STATUS[q.status]}</Pill>
                      {q.convertedInvoiceId ? <Pill>Invoiced</Pill> : null}
                      {q.convertedOrderId ? <Pill>Ordered</Pill> : null}
                    </span>
                  </td>
                  <td className={`${cellCls} tabular-nums text-muted`}>{fmtDay(q.validUntil)}</td>
                  <td className={numCls}>{money(q.totalCents)}</td>
                  <td className={`${cellCls} text-right`}>
                    {actor.canEdit ? (
                      <QuoteActions id={q.id} status={q.status} label={label} convertedInvoiceId={q.convertedInvoiceId} convertedOrderId={q.convertedOrderId} />
                    ) : (
                      <a className="text-sm font-semibold underline" href={`/api/ops/quotes/${q.id}/pdf`} target="_blank" rel="noreferrer">
                        PDF
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
