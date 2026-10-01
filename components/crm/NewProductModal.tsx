// Marketr CRM — new product modal (Phase 17 slice 3).

"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { backdropCls, btnGhost, btnPrimary, errorBoxCls, inputCls, labelCls, modalWrapCls } from "./ui";

function toCents(dollars: string): number | null {
  const n = Number(dollars);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function NewProductModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("0");
  const [track, setTrack] = useState(true);
  const [threshold, setThreshold] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const priceCents = toCents(price);
    const stockQty = Number(stock);
    const lowStockThreshold = Number(threshold);
    if (!name.trim()) return setError("Name is required.");
    if (!sku.trim()) return setError("SKU is required.");
    if (priceCents === null) return setError("Price must be a non-negative number.");
    if (!Number.isInteger(stockQty) || stockQty < 0)
      return setError("Initial stock must be a non-negative integer.");
    if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0)
      return setError("Threshold must be a non-negative integer.");
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/ops/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          sku: sku.trim(),
          priceCents,
          // Balance always starts at 0 — initial stock enters through the
          // ledger below, so the balance can never drift from its history.
          stockQty: 0,
          trackInventory: track,
          lowStockThreshold,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Create failed.");
      const productId = (d.row as { id?: string } | undefined)?.id;
      if (track && stockQty > 0) {
        if (!productId) throw new Error("Product created but id missing — cannot book initial stock.");
        const mr = await fetch("/api/ops/inventory-txns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId,
            delta: stockQty,
            reason: "restock",
            note: "Initial stock",
          }),
        });
        const md = await mr.json();
        if (!mr.ok) throw new Error(md.error ?? "Product created, but initial stock move failed.");
      }
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={backdropCls} onClick={onClose} />
      <div className={modalWrapCls}>
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <h3 className="text-lg font-bold tracking-tight text-ink">New product</h3>
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
          <div>
            <label className={labelCls}>Name</label>
            <input className={`${inputCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Retainer — SEO" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>SKU</label>
              <input className={`${inputCls} w-full`} value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SEO-RET" />
            </div>
            <div>
              <label className={labelCls}>Price (USD)</label>
              <input className={`${inputCls} w-full`} type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Initial stock</label>
              <input className={`${inputCls} w-full`} type="number" min={0} step={1} value={stock} onChange={(e) => setStock(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Low-stock threshold</label>
              <input className={`${inputCls} w-full`} type="number" min={0} step={1} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />
            Track inventory for this product
          </label>
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
              {busy && <Loader2 size={14} className="animate-spin" />} Create product
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
