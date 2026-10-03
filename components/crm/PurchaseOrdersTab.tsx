// Marketr CRM — Purchase orders tab (Phase 17 slice 3).
// Draft → approve → send → received / cancelled. Sending is a gated money
// commitment; receiving atomically books restock txns. Operations lives
// UNDER the CRM per Tico's lock. Dense table + badges, Studio house pattern.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardList, Loader2, Plus, Search } from "lucide-react";
import { formatMoney } from "./types";
import { PODetail } from "./PODetail";
import { NewPOModal } from "./NewPOModal";
import { btnPrimary, chipCls, errorBoxCls, inputCls, selectCls, tableCls, tableWrapCls, trClickableCls } from "./ui";
import { activateOnKey } from "@/lib/ui/keyboard";

export interface OpsPurchaseOrder {
  id: string;
  supplierId: string | null;
  supplierName: string | null;
  lineItems: Array<{ productId?: string; name: string; sku?: string; qty: number; priceCents: number }>;
  taxCents: number;
  totalCents: number;
  status: "draft" | "sent" | "received" | "cancelled";
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
}

export interface SupplierRef {
  id: string;
  name: string;
  company: string | null;
}

const STATUS_FILTERS = ["all", "draft", "sent", "received", "cancelled"] as const;

export const PO_STATUS_META: Record<string, { label: string; tint: string }> = {
  draft: { label: "Draft", tint: "bg-line text-ink" },
  sent: { label: "Sent", tint: "bg-canvas text-ink" },
  received: { label: "Received", tint: "bg-canvas text-ink" },
  cancelled: { label: "Cancelled", tint: "bg-canvas text-subtle" },
};

export function shortPOId(id: string): string {
  return id.length > 12 ? id.slice(-8).toUpperCase() : id.toUpperCase();
}

function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function PurchaseOrdersTab() {
  const [pos, setPos] = useState<OpsPurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Record<string, SupplierRef>>({});
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
      const params = new URLSearchParams({ limit: "200" });
      if (status !== "all") params.set("status", status);
      const r = await fetch(`/api/ops/purchase-orders?${params.toString()}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to load purchase orders.");
      const rows = (d.rows ?? []) as OpsPurchaseOrder[];
      setPos(rows);
      const ids = [...new Set(rows.map((x) => x.supplierId).filter(Boolean))] as string[];
      if (ids.length > 0) {
        const sr = await fetch("/api/ops/purchase-orders/suppliers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        const sd = await sr.json();
        if (sr.ok) {
          const map: Record<string, SupplierRef> = {};
          for (const s of sd.suppliers as SupplierRef[]) map[s.id] = s;
          setSuppliers(map);
        }
      } else {
        setSuppliers({});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load purchase orders.");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const supplierLabel = useCallback(
    (po: OpsPurchaseOrder): string => {
      const s = po.supplierId ? suppliers[po.supplierId] : undefined;
      if (s) return `${s.name}${s.company ? ` ${s.company}` : ""}`;
      return po.supplierName ?? "—";
    },
    [suppliers],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return pos;
    return pos.filter(
      (po) =>
        po.id.toLowerCase().includes(needle) ||
        supplierLabel(po).toLowerCase().includes(needle),
    );
  }, [pos, q, supplierLabel]);

  const totals = useMemo(() => {
    const open = pos
      .filter((p) => p.status === "sent")
      .reduce((s, p) => s + p.totalCents, 0);
    return { open };
  }, [pos]);

  const selected = selectedId ? pos.find((p) => p.id === selectedId) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">Purchase orders</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            Draft → approve → send → received. Sending is a money commitment and needs your approval.
          </p>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-muted">
          <span>
            Open orders{" "}
            <span className="font-bold text-ink tabular-nums">{formatMoney(totals.open)}</span>
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
              {s === "all" ? "All statuses" : PO_STATUS_META[s].label}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            className={`${inputCls} pl-8`}
            placeholder="Search purchase orders…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className={btnPrimary}
        >
          <Plus size={15} /> New purchase order
        </button>
      </div>

      {error && (
        <div className={errorBoxCls}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={16} className="animate-spin" /> Loading purchase orders…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-line bg-canvas px-4 py-10 text-center">
          <ClipboardList size={28} className="mx-auto text-subtle" />
          <p className="mt-2 text-[13px] font-semibold text-ink">No purchase orders yet</p>
          <p className="mt-0.5 text-[13px] text-muted">
            Create a draft — it stays a draft until you approve the send.
          </p>
        </div>
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[820px]`}>
            <thead>
              <tr>
                <th>PO</th>
                <th>Supplier</th>
                <th>Status</th>
                <th className="text-right">Total</th>
                <th>Sent</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((po) => {
                const meta = PO_STATUS_META[po.status];
                return (
                  <tr key={po.id} onClick={() => setSelectedId(po.id)} tabIndex={0} onKeyDown={activateOnKey(() => setSelectedId(po.id))} className={trClickableCls}>
                    <td className="font-semibold text-ink">PO-{shortPOId(po.id)}</td>
                    <td className="text-ink">{supplierLabel(po)}</td>
                    <td>
                      <span className={chipCls}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="text-right font-semibold tabular-nums">{formatMoney(po.totalCents)}</td>
                    <td className="text-muted">{fmtDate(po.sentAt)}</td>
                    <td className="text-muted">{fmtDate(po.receivedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <PODetail
          po={selected}
          supplier={selected.supplierId ? suppliers[selected.supplierId] ?? null : null}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      )}
      {showNew && <NewPOModal onClose={() => setShowNew(false)} onCreated={load} />}
    </div>
  );
}
