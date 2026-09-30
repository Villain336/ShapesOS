// Marketr CRM — new purchase order modal (Phase 17 slice 3).
// Draft creator (free logged write). Sending is gated at the detail view.

"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { formatMoney } from "./types";
import type { OpsProduct } from "./InventoryTab";

interface LeadHit {
  id: string;
  name: string;
  company?: string | null;
}

interface POLine {
  productId: string;
  name: string;
  qty: string;
  price: string;
}

function toCents(dollars: string): number | null {
  const n = Number(dollars);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function NewPOModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [supplier, setSupplier] = useState<LeadHit | null>(null);
  const [supplierName, setSupplierName] = useState("");
  const [supplierQuery, setSupplierQuery] = useState("");
  const [hits, setHits] = useState<LeadHit[]>([]);
  const [showHits, setShowHits] = useState(false);
  const [searching, setSearching] = useState(false);
  const [products, setProducts] = useState<OpsProduct[]>([]);
  const [items, setItems] = useState<POLine[]>([{ productId: "", name: "", qty: "1", price: "" }]);
  const [tax, setTax] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/ops/products?limit=200");
        const d = await r.json();
        if (r.ok) setProducts((d.rows ?? []) as OpsProduct[]);
      } catch {
        /* product linking is optional; the PO works without it */
      }
    })();
  }, []);

  useEffect(() => {
    const needle = supplierQuery.trim();
    if (needle.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/crm/leads?q=${encodeURIComponent(needle)}&limit=8`);
        const d = await r.json();
        if (!cancelled && r.ok) {
          setHits(
            ((d.leads ?? []) as Array<{ id: string; name: string; company?: string | null }>).map((l) => ({
              id: l.id,
              name: l.name,
              company: l.company,
            })),
          );
          setShowHits(true);
        }
      } catch {
        /* best-effort */
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [supplierQuery]);

  const subtotal = items.reduce((s, it) => {
    const c = toCents(it.price);
    const q = Number(it.qty);
    return s + (c !== null && Number.isInteger(q) && q > 0 ? c * q : 0);
  }, 0);

  async function submit() {
    const taxCents = tax.trim() === "" ? 0 : toCents(tax);
    if (taxCents === null) return setError("Tax must be a non-negative number.");
    const lineItems: Array<{ productId?: string; name: string; qty: number; priceCents: number }> = [];
    for (const it of items) {
      const priceCents = toCents(it.price);
      const qty = Number(it.qty);
      if (!it.name.trim()) return setError("Every line item needs a name.");
      if (priceCents === null) return setError("Line prices must be non-negative numbers.");
      if (!Number.isInteger(qty) || qty < 1) return setError("Line quantities must be positive integers.");
      lineItems.push({
        ...(it.productId ? { productId: it.productId } : {}),
        name: it.name.trim(),
        qty,
        priceCents,
      });
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/ops/purchase-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(supplier ? { supplierId: supplier.id } : {}),
          ...(supplierName.trim() ? { supplierName: supplierName.trim() } : {}),
          lineItems,
          taxCents,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Create failed.");
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
      <div className="crm-backdrop" onClick={onClose} />
      <div className="crm-modal">
        <div className="flex items-start justify-between border-b border-stone-200 px-5 py-4">
          <div>
            <h3 className="text-lg font-bold tracking-tight text-stone-900">New purchase order</h3>
            <p className="mt-0.5 text-[13px] text-stone-500">
              Drafts are free — sending needs your approval (money is a red lane).
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {error}
            </div>
          )}

          <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
            Supplier (CRM lead, optional)
          </label>
          <div className="relative mt-1">
            {supplier ? (
              <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
                <span className="text-[13px] font-medium text-stone-800">
                  {supplier.name}
                  {supplier.company && <span className="text-stone-400"> · {supplier.company}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSupplier(null);
                    setSupplierQuery("");
                  }}
                  className="text-[12px] font-semibold text-stone-500 hover:text-stone-800"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
                  <input
                    className="crm-input w-full pl-8"
                    placeholder="Search leads by name or company…"
                    value={supplierQuery}
                    onChange={(e) => setSupplierQuery(e.target.value)}
                    onFocus={() => hits.length > 0 && setShowHits(true)}
                  />
                  {searching && <Loader2 size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-stone-400" />}
                </div>
                {showHits && hits.length > 0 && (
                  <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-stone-200 bg-white shadow-lg">
                    {hits.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => {
                          setSupplier(h);
                          setShowHits(false);
                        }}
                        className="block w-full px-3 py-2 text-left text-[13px] hover:bg-stone-50"
                      >
                        <span className="font-medium text-stone-800">{h.name}</span>
                        {h.company && <span className="text-stone-400"> · {h.company}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="mt-2">
            <input
              className="crm-input w-full"
              placeholder="Or type a supplier name…"
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
            />
          </div>

          <div className="mt-4 flex items-center justify-between">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
              Line items
            </label>
            <button
              type="button"
              onClick={() => setItems([...items, { productId: "", name: "", qty: "1", price: "" }])}
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--brand-700)] hover:underline"
            >
              <Plus size={13} /> Add line
            </button>
          </div>
          <p className="mt-1 text-[12px] text-stone-500">
            Link a line to a catalog product and receiving the PO books a restock for it.
          </p>
          <div className="mt-1 space-y-2">
            {items.map((it, i) => (
              <div key={i} className="flex gap-2">
                <select
                  className="crm-select w-36"
                  value={it.productId}
                  onChange={(e) => {
                    const pid = e.target.value;
                    const prod = products.find((p) => p.id === pid);
                    setItems(
                      items.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              productId: pid,
                              name: prod && !x.name ? prod.name : x.name,
                            }
                          : x,
                      ),
                    );
                  }}
                  aria-label="Linked product"
                >
                  <option value="">No product link</option>
                  {products
                    .filter((p) => p.trackInventory)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.sku})
                      </option>
                    ))}
                </select>
                <input
                  className="crm-input flex-1"
                  placeholder="Item name"
                  value={it.name}
                  onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <input
                  className="crm-input w-16"
                  placeholder="Qty"
                  inputMode="numeric"
                  value={it.qty}
                  onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                />
                <input
                  className="crm-input w-28"
                  placeholder="$0.00"
                  inputMode="decimal"
                  value={it.price}
                  onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))}
                />
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setItems(items.filter((_, j) => j !== i))}
                    className="rounded-lg p-2 text-stone-400 hover:bg-stone-100 hover:text-red-600"
                    aria-label="Remove line"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                Tax (USD)
              </label>
              <input
                className="crm-input mt-1 w-full"
                placeholder="0.00"
                inputMode="decimal"
                value={tax}
                onChange={(e) => setTax(e.target.value)}
              />
            </div>
            <div className="flex items-end justify-end">
              <p className="text-[13px] text-stone-500">
                Subtotal{" "}
                <span className="font-bold text-stone-900 tabular-nums">{formatMoney(subtotal)}</span>
              </p>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-stone-300 bg-white px-3 py-[7px] text-[13px] font-semibold text-stone-700 hover:bg-stone-50">
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={submit}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-[7px] text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
            >
              {busy && <Loader2 size={14} className="animate-spin" />} Create draft
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
