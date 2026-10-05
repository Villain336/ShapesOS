"use client";

// ShapesOS — Phase 10 (store): variant picker + quantity + "Add to cart".
// Posts to the public cart API; prices shown here are display only — the
// server re-prices every cart from the database.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Loader2, ShoppingBag } from "lucide-react";
import { shopBtnPrimary, shopErrorMark, shopErrorText, shopSelect, stockLabel } from "./styles";

export interface AddToCartVariant {
  id: string | null;
  name: string;
  priceLabel: string;
  available: number | null;
}

export function AddToCart({ storeSlug, productId, variants }: { storeSlug: string; productId: string; variants: AddToCartVariant[] }) {
  const router = useRouter();
  const firstInStock = variants.findIndex((v) => v.available === null || v.available > 0);
  const [idx, setIdx] = useState(firstInStock >= 0 ? firstInStock : 0);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = variants[idx]!;
  const soldOut = v.available !== null && v.available <= 0;
  const maxQty = Math.max(1, Math.min(99, v.available ?? 99));

  async function add() {
    setBusy(true);
    setError(null);
    setAdded(false);
    try {
      const res = await fetch(`/api/shop/${encodeURIComponent(storeSlug)}/cart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "add", productId, variantId: v.id, qty }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't add this to your cart. Try again.");
      setAdded(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add this to your cart. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {variants.length > 1 && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold text-muted">Option</span>
          <select className={shopSelect} value={idx} onChange={(e) => { setIdx(Number(e.target.value)); setQty(1); setAdded(false); }}>
            {variants.map((x, i) => (
              <option key={x.id ?? "default"} value={i}>
                {x.name} · {x.priceLabel} · {stockLabel(x.available)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold text-muted">Quantity</span>
          <select className={`${shopSelect} w-24`} value={qty} onChange={(e) => setQty(Number(e.target.value))} disabled={soldOut}>
            {Array.from({ length: maxQty }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={shopBtnPrimary} onClick={add} disabled={busy || soldOut}>
          {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <ShoppingBag size={16} aria-hidden />}
          {soldOut ? "Out of stock" : busy ? "Adding" : "Add to cart"}
        </button>
      </div>
      <p className="text-[13px] text-muted">{stockLabel(v.available)}</p>
      {added && (
        <p className="flex items-center gap-2 text-[14px] font-medium" role="status">
          <Check size={16} aria-hidden /> Added to your cart.
          <Link href={`/shop/${storeSlug}/cart`} className="underline hover:text-muted">
            View cart
          </Link>
        </p>
      )}
      {error && (
        <p className={shopErrorText} role="alert">
          <span className={shopErrorMark} aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}
