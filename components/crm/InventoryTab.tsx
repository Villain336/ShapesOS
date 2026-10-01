// Marketr CRM — Inventory tab (Phase 17 slice 3).
// Product/stock list, low-stock alerts, stock history. Operations lives
// UNDER the CRM per Tico's lock. Dense table + badges, Studio house pattern.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Boxes, Loader2, Plus, Search } from "lucide-react";
import { formatMoney } from "./types";
import { ProductDetail } from "./ProductDetail";
import { NewProductModal } from "./NewProductModal";
import { StockMoveModal } from "./StockMoveModal";
import { btnGhost, btnPrimary, chipCls, errorBoxCls, inputCls, needsBoxCls, tableCls, tableWrapCls, trClickableCls } from "./ui";

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
  untracked: { label: "Not tracked", tint: "bg-canvas text-muted" },
  out: { label: "Out of stock", tint: "bg-canvas text-ink" },
  low: { label: "Low stock", tint: "bg-canvas text-ink" },
  ok: { label: "In stock", tint: "bg-canvas text-ink" },
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
          <h2 className="text-xl font-bold tracking-tight text-ink">Inventory</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            Stock moves only through inventory transactions — the ledger and the balance can never drift.
          </p>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-muted">
          <span>
            Products{" "}
            <span className="font-bold text-ink tabular-nums">{products.length}</span>
          </span>
          <span>
            Low-stock alerts{" "}
            <span className="font-bold text-ink tabular-nums">{alerts.length}</span>
          </span>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className={needsBoxCls}>
          <div className="flex items-center gap-2 text-[13px] font-bold text-ink">
            <span className="aos-shape aos-shape--needs aos-shape--edged" role="img" aria-label="Needs attention" /> {alerts.length} product{alerts.length === 1 ? "" : "s"} at or
            below the low-stock threshold
          </div>
          <p className="mt-1 text-[13px] text-ink">
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
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            className={`${inputCls} pl-8`}
            placeholder="Search products…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={() => setShowMove(true)}
          className={btnGhost}
        >
          <ArrowLeftRight size={15} /> Record stock move
        </button>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className={btnPrimary}
        >
          <Plus size={15} /> New product
        </button>
      </div>

      {error && (
        <div className={errorBoxCls}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={16} className="animate-spin" /> Loading inventory…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-line bg-canvas px-4 py-10 text-center">
          <Boxes size={28} className="mx-auto text-subtle" />
          <p className="mt-2 text-[13px] font-semibold text-ink">No products yet</p>
          <p className="mt-0.5 text-[13px] text-muted">
            Add a product to start tracking stock.
          </p>
        </div>
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[760px]`}>
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
                  <tr key={p.id} onClick={() => setSelectedId(p.id)} className={trClickableCls}>
                    <td className="font-semibold text-ink">{p.name}</td>
                    <td className="text-muted">{p.sku}</td>
                    <td className="text-right font-semibold tabular-nums text-ink">
                      {p.trackInventory ? p.stockQty : "—"}
                    </td>
                    <td className="text-right tabular-nums text-muted">
                      {p.trackInventory ? p.lowStockThreshold : "—"}
                    </td>
                    <td>
                      <span className={chipCls}>
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
