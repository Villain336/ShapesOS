// Marketr CRM — Invoicing tab (Phase 17 slice 2).
// Operations lives UNDER the CRM per Tico's lock (no top-level area).
// Dense table + filter toolbar + status badges, Studio house pattern.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Loader2, Plus, Search } from "lucide-react";
import { formatMoney } from "./types";
import { InvoiceDetail } from "./InvoiceDetail";
import { NewInvoiceModal } from "./NewInvoiceModal";

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
}

export interface CustomerRef {
  id: string;
  name: string;
  company: string | null;
}

const STATUS_FILTERS = ["all", "draft", "sent", "paid", "overdue", "cancelled"] as const;

export const INVOICE_STATUS_META: Record<string, { label: string; tint: string }> = {
  draft: { label: "Draft", tint: "bg-stone-200 text-stone-700" },
  sent: { label: "Sent", tint: "bg-blue-100 text-blue-700" },
  paid: { label: "Paid", tint: "bg-green-100 text-green-700" },
  overdue: { label: "Overdue", tint: "bg-red-100 text-red-700" },
  cancelled: { label: "Voided", tint: "bg-stone-100 text-stone-400" },
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
          <h2 className="text-xl font-bold tracking-tight text-stone-900">Invoicing</h2>
          <p className="mt-0.5 text-[13px] text-stone-500">
            Draft → approve → send → paid. Sending an invoice needs your approval — money is a red lane.
          </p>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-stone-500">
          <span>
            Outstanding <span className="font-bold text-stone-900 tabular-nums">{formatMoney(totals.outstanding)}</span>
          </span>
          <span>
            Overdue <span className="font-bold text-red-700 tabular-nums">{formatMoney(totals.overdue)}</span>
          </span>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="crm-select"
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
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            className="crm-input pl-8"
            placeholder="Search invoices…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-[7px] text-[13px] font-semibold text-white hover:bg-[var(--brand-700)]"
        >
          <Plus size={15} /> New invoice
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-stone-500">
          <Loader2 size={16} className="animate-spin" /> Loading invoices…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-10 text-center">
          <FileText size={28} className="mx-auto text-stone-300" />
          <p className="mt-2 text-[13px] font-semibold text-stone-700">No invoices yet</p>
          <p className="mt-0.5 text-[13px] text-stone-500">
            Create a draft invoice — it stays a draft until you approve the send.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="crm-table w-full min-w-[860px]">
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
                  <tr key={inv.id} onClick={() => setSelectedId(inv.id)} className="hover:bg-[var(--brand-50)]/40">
                    <td className="font-semibold text-stone-900">INV-{shortInvoiceId(inv.id)}</td>
                    <td>
                      {c ? (
                        <>
                          <span className="font-medium text-stone-800">{c.name}</span>
                          {c.company && <span className="text-stone-400"> · {c.company}</span>}
                        </>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.tint}`}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="text-right font-semibold tabular-nums">{formatMoney(inv.totalCents)}</td>
                    <td className={inv.status === "overdue" ? "font-semibold text-red-700" : ""}>
                      {fmtDate(inv.dueAt)}
                    </td>
                    <td className="text-stone-500">{fmtDate(inv.sentAt)}</td>
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
