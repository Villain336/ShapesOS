// Marketr CRM — product detail slide-over (Phase 17 slice 3).
// Stock history (the inventory-txn ledger), threshold editing, stock moves.

"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight, Loader2, X } from "lucide-react";
import { formatMoney } from "./types";
import {
  STOCK_STATUS_META,
  productStockStatus,
  type OpsProduct,
} from "./InventoryTab";
import { StockMoveModal } from "./StockMoveModal";
import { backdropCls, btnGhost, btnPrimary, chipCls, errorBoxCls, inputCls, labelCls, slideoverCls, tableCls, tableWrapCls } from "./ui";

interface OpsInventoryTxn {
  id: string;
  delta: number;
  reason: "sale" | "restock" | "adjustment" | "transfer" | "production" | "consumption" | "scrap";
  actor: string | null;
  note: string | null;
  createdAt: string;
}

const REASON_META: Record<string, { label: string; tint: string }> = {
  sale: { label: "Sale", tint: "bg-canvas text-ink" },
  restock: { label: "Restock", tint: "bg-canvas text-ink" },
  adjustment: { label: "Adjustment", tint: "bg-line text-ink" },
  transfer: { label: "Transfer", tint: "bg-canvas text-ink" },
  // Phase 12 (mfgpos): manufacturing-order and scrap moves.
  production: { label: "Produced", tint: "bg-canvas text-ink" },
  consumption: { label: "Used in production", tint: "bg-canvas text-ink" },
  scrap: { label: "Scrapped", tint: "bg-line text-ink" },
};

function fmtDateTime(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function ProductDetail({
  product,
  onClose,
  onChanged,
}: {
  product: OpsProduct;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [txns, setTxns] = useState<OpsInventoryTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(String(product.lowStockThreshold));
  const [saving, setSaving] = useState(false);
  const [showMove, setShowMove] = useState(false);

  const meta = STOCK_STATUS_META[productStockStatus(product)];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(
          `/api/ops/inventory-txns?productId=${encodeURIComponent(product.id)}&limit=100`,
        );
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Failed to load history.");
        if (!cancelled) setTxns((d.rows ?? []) as OpsInventoryTxn[]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [product.id]);

  async function saveThreshold() {
    const n = Number(threshold);
    if (!Number.isInteger(n) || n < 0) {
      setError("Threshold must be a non-negative integer.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/ops/products", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id, lowStockThreshold: n }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Save failed.");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className={backdropCls} onClick={onClose} aria-hidden />
      <div className={slideoverCls}>
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between border-b border-line px-5 py-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold tracking-tight text-ink">{product.name}</h3>
                <span className={chipCls}>
                  {meta.label}
                </span>
              </div>
              <p className="mt-0.5 text-[0.8125rem] text-muted">
                {product.sku} · {formatMoney(product.priceCents)} ·{" "}
                {product.trackInventory ? `${product.stockQty} in stock` : "not tracked"}
              </p>
            </div>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {error && (
              <div className={`${errorBoxCls} mb-3`}>
                {error}
              </div>
            )}

            <div className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-line bg-canvas px-4 py-3">
              <div>
                <label className={labelCls}>
                  Low-stock threshold
                </label>
                <input
                  className={`${inputCls} w-28`}
                  type="number"
                  min={0}
                  step={1}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={saveThreshold}
                className={btnPrimary}
              >
                {saving && <Loader2 size={14} className="animate-spin" />} Save
              </button>
              <button
                type="button"
                onClick={() => setShowMove(true)}
                className={btnGhost}
              >
                <ArrowLeftRight size={15} /> Record stock move
              </button>
              <p className="w-full text-[0.75rem] text-muted">
                Alerts when stock is at or below the threshold. Stock quantity itself can only
                change through inventory transactions — never edited directly.
              </p>
            </div>

            <h4 className="mb-2 text-[0.8125rem] font-bold text-ink">Stock history</h4>
            {loading ? (
              <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
                <Loader2 size={16} className="animate-spin" /> Loading history…
              </div>
            ) : txns.length === 0 ? (
              <p className="text-[0.8125rem] text-muted">No stock moves recorded yet.</p>
            ) : (
              <div className={tableWrapCls}>
                <table className={`${tableCls}`}>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Reason</th>
                      <th className="text-right">Change</th>
                      <th>Actor</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txns.map((t) => {
                      const rm = REASON_META[t.reason] ?? REASON_META.adjustment;
                      return (
                        <tr key={t.id}>
                          <td className="whitespace-nowrap text-muted">{fmtDateTime(t.createdAt)}</td>
                          <td>
                            <span className={chipCls}>
                              {rm.label}
                            </span>
                          </td>
                          <td className="text-right font-semibold tabular-nums text-ink">
                            {t.delta > 0 ? `+${t.delta}` : t.delta}
                          </td>
                          <td className="text-muted">{t.actor ?? "—"}</td>
                          <td className="text-muted">{t.note ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
      {showMove && (
        <StockMoveModal
          products={[product]}
          fixedProduct={product}
          onClose={() => setShowMove(false)}
          onRecorded={() => {
            setShowMove(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}
