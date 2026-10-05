// Marketr — Phase 17 slice 7: OpsInvoiceCard, a registered generative
// component. The agent emits only { invoiceId }; the card loads live invoice
// data from the ops API. Presentational only — no writes, no approval
// actions (sends happen through the Actions queue after human approval).
//
// Agentic OS (docs/design/DESIGN.md): tokens only, Lucide icons only, dense
// table styling like the invoices UI. Invoice status is a business record, not
// an agent state, so its badge stays neutral (no status colors).

"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2 } from "lucide-react";

export interface OpsInvoiceCardProps {
  /** Invoice id (the agent emits this; never agent-invented content). */
  invoiceId: string;
}

interface InvoiceLine {
  description: string;
  qty: number;
  priceCents: number;
}

interface InvoiceRow {
  id: string;
  customerId: string | null;
  lineItems: InvoiceLine[];
  taxCents: number;
  totalCents: number;
  status: string;
  dueAt: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-canvas text-ink",
  sent: "bg-paper text-ink shadow-control",
  paid: "bg-ink text-white",
  overdue: "bg-paper text-ink shadow-outline",
  cancelled: "bg-canvas text-muted",
};

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function OpsInvoiceCard({ invoiceId }: OpsInvoiceCardProps) {
  const [invoice, setInvoice] = useState<InvoiceRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/ops/invoices?limit=200`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: InvoiceRow[] };
      const found = (data.items ?? []).find((r) => r.id === invoiceId) ?? null;
      setInvoice(found);
      if (!found) {
        setError("Invoice not found in this workspace.");
        return;
      }
      if (found.customerId) {
        // Resolve the customer name through the slice-2 resolver (best effort).
        try {
          const cres = await fetch(`/api/ops/invoices/customers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ customerIds: [found.customerId] }),
          });
          if (cres.ok) {
            const cdata = (await cres.json()) as { customers?: Record<string, string> };
            setCustomerName(cdata.customers?.[found.customerId] ?? found.customerId);
          }
        } catch {
          setCustomerName(found.customerId);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load invoice.");
    }
  }, [invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !invoice) {
    return (
      <div className="rounded-lg bg-paper p-4 text-[13px] text-muted shadow-hairline">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="rounded-lg bg-paper p-4 text-[13px] text-muted shadow-hairline">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading invoice…</span>
        </div>
      </div>
    );
  }

  const subtotal = invoice.lineItems.reduce((s, l) => s + l.qty * l.priceCents, 0);

  return (
    <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
      <div className="flex items-center justify-between border-b border-line bg-canvas px-4 py-2.5">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-ink" />
          <span className="text-sm font-semibold text-ink">
            Invoice {invoice.id.slice(0, 8)}…
          </span>
          {customerName && <span className="text-[13px] text-muted">{customerName}</span>}
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            STATUS_BADGE[invoice.status] ?? STATUS_BADGE.draft
          }`}
        >
          {invoice.status}
        </span>
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-muted">
            <th className="px-4 py-2 font-medium">Item</th>
            <th className="px-2 py-2 text-right font-medium">Qty</th>
            <th className="px-2 py-2 text-right font-medium">Price</th>
            <th className="px-4 py-2 text-right font-medium">Line total</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lineItems.map((l, i) => (
            <tr key={i} className="border-t border-line hover:bg-hover-paper">
              <td className="px-4 py-2 text-ink">{l.description}</td>
              <td className="px-2 py-2 text-right tabular-nums text-muted">{l.qty}</td>
              <td className="px-2 py-2 text-right tabular-nums text-muted">{fmtCents(l.priceCents)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink">{fmtCents(l.qty * l.priceCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line">
            <td colSpan={3} className="px-4 py-1.5 text-right text-muted">Subtotal</td>
            <td className="px-4 py-1.5 text-right tabular-nums text-ink">{fmtCents(subtotal)}</td>
          </tr>
          <tr>
            <td colSpan={3} className="px-4 py-1.5 text-right text-muted">Tax</td>
            <td className="px-4 py-1.5 text-right tabular-nums text-ink">{fmtCents(invoice.taxCents)}</td>
          </tr>
          <tr>
            <td colSpan={3} className="px-4 py-2 text-right font-semibold text-ink">Total</td>
            <td className="px-4 py-2 text-right font-semibold tabular-nums text-ink">{fmtCents(invoice.totalCents)}</td>
          </tr>
        </tfoot>
      </table>
      {invoice.dueAt && (
        <div className="border-t border-line px-4 py-2 text-[12px] text-muted">
          Due {new Date(invoice.dueAt).toLocaleDateString()}
        </div>
      )}
    </div>
  );
}
