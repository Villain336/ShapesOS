// Marketr CRM — record a stock move (Phase 17 slice 3).
// Moves are inventory-txn creates: sale (negative), restock (positive),
// adjustment (signed). The balance updates atomically server-side.

"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import type { OpsProduct } from "./InventoryTab";
import { backdropCls, btnGhost, btnPrimary, errorBoxCls, inputCls, labelCls, modalWrapCls, selectCls } from "./ui";

type Reason = "sale" | "restock" | "adjustment";

export function StockMoveModal({
  products,
  fixedProduct,
  onClose,
  onRecorded,
}: {
  products: OpsProduct[];
  /** When set (from the product detail), the product picker is hidden. */
  fixedProduct: OpsProduct | null;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const tracked = products.filter((p) => p.trackInventory);
  const [productId, setProductId] = useState(fixedProduct?.id ?? tracked[0]?.id ?? "");
  const [reason, setReason] = useState<Reason>("restock");
  const [qty, setQty] = useState("1");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const n = Number(qty);
    if (!productId) return setError("Pick a product.");
    if (!Number.isInteger(n) || n === 0) return setError("Quantity must be a non-zero integer.");
    // Sign discipline: sales decrement, restocks increment, adjustments
    // go as entered.
    const delta = reason === "sale" ? -Math.abs(n) : reason === "restock" ? Math.abs(n) : n;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/ops/inventory-txns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          delta,
          reason,
          note: note.trim() || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Move failed.");
      onRecorded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Move failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={backdropCls} onClick={onClose} aria-hidden />
      <div className={modalWrapCls}>
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <h3 className="text-lg font-bold tracking-tight text-ink">Record stock move</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          {error && (
            <div className={errorBoxCls}>
              {error}
            </div>
          )}
          {!fixedProduct && (
            <div>
              <label className={labelCls}>Product</label>
              <select className={`${selectCls} w-full`} value={productId} onChange={(e) => setProductId(e.target.value)}>
                {tracked.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku}) — {p.stockQty} in stock
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Reason</label>
              <select className={`${selectCls} w-full`} value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
                <option value="restock">Restock (+)</option>
                <option value="sale">Sale (−)</option>
                <option value="adjustment">Adjustment (±)</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>
                Quantity{reason === "adjustment" ? " (signed)" : ""}
              </label>
              <input className={`${inputCls} w-full`} type="number" step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Note (optional)</label>
            <input className={`${inputCls} w-full`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why is stock moving?" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className={btnGhost}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={submit}
              className={btnPrimary}
            >
              {busy && <Loader2 size={14} className="animate-spin" />} Record move
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
