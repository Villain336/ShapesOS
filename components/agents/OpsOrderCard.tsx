// Marketr — Phase 17 slice 7: OpsOrderCard, a registered generative
// component. The agent emits only { orderId }; the card loads live order
// data from the ops API. Presentational only — orders are records-only in
// Phase 17 (no commerce writes; Medusa deferred to Phase 18).
//
// House pattern: --brand-600/700/50 vars, never hardcoded primaries; Lucide
// icons only; dense table styling like the orders UI.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Package } from "lucide-react";

export interface OpsOrderCardProps {
  /** Order id (the agent emits this; never agent-invented content). */
  orderId: string;
}

interface OrderItem {
  productId?: string | null;
  name?: string;
  description?: string;
  sku?: string | null;
  qty: number;
  priceCents: number;
}

interface OrderRow {
  id: string;
  customerId: string | null;
  items: OrderItem[];
  taxCents: number;
  totalCents: number;
  status: string;
}

const STATUS_BADGE: Record<string, string> = {
  new: "bg-sky-50 text-sky-800 border-sky-200",
  paid: "bg-[var(--brand-50)] text-[var(--brand-700)] border-[var(--brand-600)]/20",
  fulfilled: "bg-stone-100 text-stone-700 border-stone-200",
  cancelled: "bg-stone-100 text-stone-500 border-stone-200",
};

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function OpsOrderCard({ orderId }: OpsOrderCardProps) {
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/ops/orders?limit=200`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: OrderRow[] };
      const found = (data.items ?? []).find((r) => r.id === orderId) ?? null;
      setOrder(found);
      if (!found) setError("Order not found in this workspace.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load order.");
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !order) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white p-4 text-[13px] text-stone-500">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white p-4 text-[13px] text-stone-500">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading order…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div className="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-[var(--brand-600)]" />
          <span className="text-sm font-semibold text-stone-900">Order {order.id.slice(0, 8)}…</span>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
            STATUS_BADGE[order.status] ?? STATUS_BADGE.new
          }`}
        >
          {order.status}
        </span>
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-stone-500">
            <th className="px-4 py-2 font-medium">Item</th>
            <th className="px-2 py-2 text-right font-medium">Qty</th>
            <th className="px-4 py-2 text-right font-medium">Line total</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((it, i) => (
            <tr key={i} className="border-t border-stone-100 hover:bg-[var(--brand-50)]/40">
              <td className="px-4 py-2 text-stone-900">
                {it.name ?? it.description ?? "Item"}
                {it.sku && <span className="ml-2 text-[12px] text-stone-500">{it.sku}</span>}
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-stone-600">{it.qty}</td>
              <td className="px-4 py-2 text-right tabular-nums text-stone-900">
                {fmtCents(it.qty * it.priceCents)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-stone-200">
            <td colSpan={2} className="px-4 py-2 text-right font-semibold text-stone-900">Total</td>
            <td className="px-4 py-2 text-right font-semibold tabular-nums text-stone-900">
              {fmtCents(order.totalCents)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
