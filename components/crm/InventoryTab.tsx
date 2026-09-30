// Marketr CRM — Inventory tab (Phase 17 slice 3).
// Product/stock list, low-stock alerts, stock history. Operations lives
// UNDER the CRM per Tico's lock. Dense table + badges, Studio house pattern.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Boxes, Loader2, Plus, Search, TriangleAlert } from "lucide-react";
import { formatMoney } from "./types";
import { ProductDetail } from "./ProductDetail";
import { NewProductModal } from "./NewProductModal";
import { StockMoveModal } from "./StockMoveModal";

export interface OpsProduct {
  id: string;
  name: string;
  sku: string;
  priceCents: number;
  stockQty: number;
  trackInventory: boolean;
  lowStockThreshold: number;
  createdAt: string;
}

export type ProductStockStatus = "untracked" | "out" | "low" | "ok";

export function productStockStatus(p: OpsProduct): ProductStockStatus {
  if (!p.trackInventory) return "untracked";
  if (p.stockQty <= 0) return "out";
  if (p.stockQty <= p.lowStockThreshold) return "low";
  return "ok";
}

export const STOCK_STATUS_META: Record<ProductStockStatus, { label: string; tint: string }> = {
  untracked: { label: "Not tracked", tint: "bg-stone-100 text-stone-500" },
  out: { label: "Out of stock", tint: "bg-red-100 text-red-700" },
  low: { label: "Low stock", tint: "bg-amber-100 text-amber-800" },
  ok: { label: "In stock", tint: "bg-green-100 text-green-700" },
};

export function InventoryTab() {
  const [products, setProducts] = useState<OpsProduct[]>([]);
  const [alerts, setAlerts] = useState<OpsProduct[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showMove, setShowMove] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pr, ar] = await Promise.all([
        fetch("/api/ops/products?limit=500"),
        fetch("/api/ops/inventory/low-stock"),
      ]);
      const pd = await pr.json();
      if (!pr.ok) throw new Error(pd.error ?? "Failed to load products.");
      const ad = await ar.json();
      setProducts((pd.rows ?? []) as OpsProduct[]);
      if (ar.ok) setAlerts((ad.products ?? []) as OpsProduct[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle),
    );
  }, [products, q]);

  const selected = selectedId ? products.find((p) => p.id === selectedId) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-stone-900">Inventory</h2>
          <p className="mt-0.5 text-[13px] text-stone-500">
            Stock moves only through inventory transactions — the ledger and the balance can never drift.
          </p>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-stone-500">
          <span>
            Products{" "}
            <span className="font-bold text-stone-900 tabular-nums">{products.length}</span>
          </span>
          <span>
            Low-stock alerts{" "}
            <span className="font-bold text-amber-700 tabular-nums">{alerts.length}</span>
          </span>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-bold text-amber-900">
            <TriangleAlert size={16} /> {alerts.length} product{alerts.length === 1 ? "" : "s"} at or
            below the low-stock threshold
          </div>
          <p className="mt-1 text-[13px] text-amber-900">
            {alerts
              .slice(0, 5)
              .map((p) => `${p.name} (${p.stockQty} left)`)
              .join(" · ")}
            {alerts.length > 5 && ` · +${alerts.length - 5} more`}
          </p>
        </div>
      )}

      {/* Filter toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            className="crm-input pl-8"
            placeholder="Search products…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={() => setShowMove(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-[7px] text-[13px] font-semibold text-stone-700 hover:bg-stone-50"
        >
          <ArrowLeftRight size={15} /> Record stock move
        </button>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-[7px] text-[13px] font-semibold text-white hover:bg-[var(--brand-700)]"
        >
          <Plus size={15} /> New product
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-stone-500">
          <Loader2 size={16} className="animate-spin" /> Loading inventory…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-10 text-center">
          <Boxes size={28} className="mx-auto text-stone-300" />
          <p className="mt-2 text-[13px] font-semibold text-stone-700">No products yet</p>
          <p className="mt-0.5 text-[13px] text-stone-500">
            Add a product to start tracking stock.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="crm-table w-full min-w-[760px]">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th className="text-right">Stock</th>
                <th className="text-right">Threshold</th>
                <th>Status</th>
                <th className="text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const st = productStockStatus(p);
                const meta = STOCK_STATUS_META[st];
                return (
                  <tr key={p.id} onClick={() => setSelectedId(p.id)} className="hover:bg-[var(--brand-50)]/40">
                    <td className="font-semibold text-stone-900">{p.name}</td>
                    <td className="text-stone-500">{p.sku}</td>
                    <td className={`text-right font-semibold tabular-nums ${st === "out" ? "text-red-700" : st === "low" ? "text-amber-700" : ""}`}>
                      {p.trackInventory ? p.stockQty : "—"}
                    </td>
                    <td className="text-right tabular-nums text-stone-500">
                      {p.trackInventory ? p.lowStockThreshold : "—"}
                    </td>
                    <td>
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.tint}`}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{formatMoney(p.priceCents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ProductDetail
          product={selected}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      )}
      {showNew && <NewProductModal onClose={() => setShowNew(false)} onCreated={load} />}
      {showMove && (
        <StockMoveModal
          products={products}
          fixedProduct={null}
          onClose={() => setShowMove(false)}
          onRecorded={load}
        />
      )}
    </div>
  );
}
