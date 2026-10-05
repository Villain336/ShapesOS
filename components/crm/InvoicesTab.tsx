// Marketr CRM — Invoicing tab (Phase 17 slice 2).
// Operations lives UNDER the CRM per Tico's lock (no top-level area).
// Dense table + filter toolbar + status badges, Studio house pattern.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Loader2, Plus, Search } from "lucide-react";
import { formatMoney } from "./types";
import { InvoiceDetail } from "./InvoiceDetail";
import { NewInvoiceModal } from "./NewInvoiceModal";
import { btnPrimary, chipCls, errorBoxCls, inputCls, selectCls, tableCls, tableWrapCls, trClickableCls } from "./ui";
import { activateOnKey } from "@/lib/ui/keyboard";
// Phase 10 (finance): real invoice numbers (INV-0001) once sent.
import { invoiceLabel } from "@/components/ops-finance/InvoiceFinancePanel";

export interface OpsInvoice {
  id: string;
  customerId: string | null;
  lineItems: Array<{ description: string; qty: number; priceCents: number }>;
  taxCents: number;
  totalCents: number;
  status: "draft" | "sent" | "paid" | "overdue" | "cancelled";
  sentAt: string | null;
  dueAt: string | null;
  createdAt: string;
  // Phase 10 (finance): number, partial payments, credit notes, delivery.
  kind?: "invoice" | "credit_note";
  number?: string | null;
  paidCents?: number;
  creditedCents?: number;
  deliveryStatus?: string | null;
  paymentLinkUrl?: string | null;
}

export interface CustomerRef {
  id: string;
  name: string;
  company: string | null;
}

const STATUS_FILTERS = ["all", "draft", "sent", "paid", "overdue", "cancelled"] as const;

export const INVOICE_STATUS_META: Record<string, { label: string; tint: string }> = {
  draft: { label: "Draft", tint: "bg-line text-ink" },
  sent: { label: "Sent", tint: "bg-canvas text-ink" },
  paid: { label: "Paid", tint: "bg-canvas text-ink" },
  overdue: { label: "Overdue", tint: "bg-canvas text-ink" },
  cancelled: { label: "Voided", tint: "bg-canvas text-subtle" },
};

export function shortInvoiceId(id: string): string {
  return id.length > 12 ? id.slice(-8).toUpperCase() : id.toUpperCase();
}

function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function InvoicesTab() {
  const [invoices, setInvoices] = useState<OpsInvoice[]>([]);
  const [customers, setCustomers] = useState<Record<string, CustomerRef>>({});
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  // Phase 4a (⌘K records): ?invoice=<id> opens that invoice.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("invoice");
    if (id) setSelectedId(id);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Sweep first: past-due sent invoices flip to overdue before we list.
      try {
        await fetch("/api/ops/invoices/sweep-overdue", { method: "POST" });
      } catch {
        /* sweep is best-effort; the list is the source of truth */
      }
      const params = new URLSearchParams({ limit: "200" });
      if (status !== "all") params.set("status", status);
      const r = await fetch(`/api/ops/invoices?${params.toString()}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to load invoices.");
      const rows = (d.rows ?? []) as OpsInvoice[];
      setInvoices(rows);
      const ids = [...new Set(rows.map((x) => x.customerId).filter(Boolean))] as string[];
      if (ids.length > 0) {
        const cr = await fetch("/api/ops/invoices/customers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        const cd = await cr.json();
        if (cr.ok) {
          const map: Record<string, CustomerRef> = {};
          for (const c of cd.customers as CustomerRef[]) map[c.id] = c;
          setCustomers(map);
        }
      } else {
        setCustomers({});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load invoices.");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return invoices;
    return invoices.filter((inv) => {
      const c = inv.customerId ? customers[inv.customerId] : undefined;
      return (
        inv.id.toLowerCase().includes(needle) ||
        (c?.name ?? "").toLowerCase().includes(needle) ||
        (c?.company ?? "").toLowerCase().includes(needle)
      );
    });
  }, [invoices, q, customers]);

  const totals = useMemo(() => {
    const outstanding = invoices
      .filter((i) => i.status === "sent" || i.status === "overdue")
      .reduce((s, i) => s + i.totalCents, 0);
    const overdue = invoices
      .filter((i) => i.status === "overdue")
      .reduce((s, i) => s + i.totalCents, 0);
    return { outstanding, overdue };
  }, [invoices]);

  const selected = selectedId ? invoices.find((i) => i.id === selectedId) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">Invoicing</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            Draft → approve → send → paid. Sending an invoice needs your approval — money is a red lane.
          </p>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-muted">
          <span>
            Outstanding <span className="font-bold text-ink tabular-nums">{formatMoney(totals.outstanding)}</span>
          </span>
          <span>
            Overdue <span className="font-bold text-ink tabular-nums">{formatMoney(totals.overdue)}</span>
          </span>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={selectCls}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          aria-label="Filter by status"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : INVOICE_STATUS_META[s].label}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            className={`${inputCls} pl-8`}
            placeholder="Search invoices…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className={btnPrimary}
        >
          <Plus size={15} /> New invoice
        </button>
      </div>

      {error && (
        <div className={errorBoxCls}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={16} className="animate-spin" /> Loading invoices…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-line bg-canvas px-4 py-10 text-center">
          <FileText size={28} className="mx-auto text-subtle" />
          <p className="mt-2 text-[13px] font-semibold text-ink">No invoices yet</p>
          <p className="mt-0.5 text-[13px] text-muted">
            Create a draft invoice — it stays a draft until you approve the send.
          </p>
        </div>
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[860px]`}>
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Status</th>
                <th className="text-right">Total</th>
                <th>Due</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const meta = INVOICE_STATUS_META[inv.status];
                const c = inv.customerId ? customers[inv.customerId] : undefined;
                return (
                  <tr key={inv.id} onClick={() => setSelectedId(inv.id)} tabIndex={0} onKeyDown={activateOnKey(() => setSelectedId(inv.id))} className={trClickableCls}>
                    <td className="font-semibold text-ink">{invoiceLabel(inv)}</td>
                    <td>
                      {c ? (
                        <>
                          <span className="font-medium text-ink">{c.name}</span>
                          {c.company && <span className="text-subtle"> · {c.company}</span>}
                        </>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                    <td>
                      <span className={chipCls}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="text-right font-semibold tabular-nums">{formatMoney(inv.totalCents)}</td>
                    <td className={inv.status === "overdue" ? "font-semibold text-ink" : ""}>
                      {fmtDate(inv.dueAt)}
                    </td>
                    <td className="text-muted">{fmtDate(inv.sentAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <InvoiceDetail
          invoice={selected}
          customer={selected.customerId ? customers[selected.customerId] ?? null : null}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      )}
      {showNew && <NewInvoiceModal onClose={() => setShowNew(false)} onCreated={load} />}
    </div>
  );
}
