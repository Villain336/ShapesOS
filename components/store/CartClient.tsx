"use client";

// ShapesOS — Phase 10 (store): the cart page's interactive part — quantities,
// remove, promotion code, checkout. Every change goes through the public
// cart API, which re-prices from the database and re-signs the cookie; the
// totals shown are always the server's. Checkout hands off to the store's
// Stripe Checkout page; when the server asks for the CAPTCHA step-up the
// existing widget (components/security/CaptchaWidget) is shown.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Lock, Package, Trash2 } from "lucide-react";
import { CaptchaWidget, type CaptchaPublicConfig } from "@/components/security/CaptchaWidget";
import type { CartView } from "@/lib/ops/store/view";
import { shopBtnPrimary, shopBtnQuiet, shopBtnSecondary, shopCard, shopErrorMark, shopErrorText, shopInput, shopSelect } from "./styles";

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p className={shopErrorText} role="alert">
      <span className={shopErrorMark} aria-hidden />
      {children}
    </p>
  );
}

export function CartClient({
  storeSlug,
  initial,
  captcha,
  paymentsReady,
}: {
  storeSlug: string;
  initial: CartView;
  captcha: CaptchaPublicConfig | null;
  /** False when the store owner hasn't connected Stripe: checkout is explained, not attempted. */
  paymentsReady: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState(initial.promo?.code ?? "");
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const api = `/api/shop/${encodeURIComponent(storeSlug)}`;

  async function cartAction(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(`${api}/cart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as CartView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't update your cart. Try again.");
      setView(data);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update your cart. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function checkout() {
    setBusy("checkout");
    setError(null);
    try {
      const res = await fetch(`${api}/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(captchaToken ? { captchaToken } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string; code?: string };
      if (res.ok && data.url) {
        window.location.assign(data.url);
        return;
      }
      if (data.code === "captcha_required" && captcha) {
        setNeedCaptcha(true);
        setCaptchaToken(null);
        setCaptchaKey((k) => k + 1);
      }
      throw new Error(data.error ?? "Checkout failed. Try again in a moment.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed. Try again in a moment.");
      setBusy(null);
    }
  }

  if (view.lines.length === 0) {
    return (
      <div className={`${shopCard} flex flex-col items-center gap-3 px-6 py-16 text-center`}>
        <Package size={28} className="text-subtle" aria-hidden />
        <p className="text-[15px] font-semibold">Your cart is empty</p>
        <Link href={`/shop/${storeSlug}`} className={shopBtnSecondary}>
          Browse products
        </Link>
      </div>
    );
  }

  const cur = view.currency;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
      <div className={`${shopCard} overflow-x-auto`}>
        <table className="w-full min-w-[520px] text-left text-[15px]">
          <thead>
            <tr className="border-b border-line text-[13px] text-muted">
              <th className="px-4 py-3 font-semibold">Item</th>
              <th className="px-4 py-3 font-semibold">Qty</th>
              <th className="px-4 py-3 text-right font-semibold">Amount</th>
              <th className="px-2 py-3">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((l) => {
              const key = `${l.productId}|${l.variantId ?? ""}`;
              return (
                <tr key={key} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 align-top">
                    {l.listingSlug ? (
                      <Link href={`/shop/${storeSlug}/p/${l.listingSlug}`} className="font-semibold hover:underline">
                        {l.name}
                      </Link>
                    ) : (
                      <span className="font-semibold">{l.name}</span>
                    )}
                    {l.unitPriceCents !== null && <div className="text-[13px] text-muted tabular-nums">{money(l.unitPriceCents, cur)} each</div>}
                    {l.issue && <ErrorLine>{l.issue}</ErrorLine>}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <select
                      className={`${shopSelect} w-20`}
                      aria-label={`Quantity of ${l.name}`}
                      value={l.qty}
                      disabled={busy !== null || l.unitPriceCents === null}
                      onChange={(e) => cartAction(key, { action: "set", productId: l.productId, variantId: l.variantId, qty: Number(e.target.value) })}
                    >
                      {Array.from({ length: Math.max(l.qty, 10) }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-right align-top font-semibold tabular-nums">{money(l.lineTotalCents, cur)}</td>
                  <td className="px-2 py-3 align-top">
                    <button
                      type="button"
                      className={shopBtnQuiet}
                      aria-label={`Remove ${l.name}`}
                      disabled={busy !== null}
                      onClick={() => cartAction(key, { action: "set", productId: l.productId, variantId: l.variantId, qty: 0 })}
                    >
                      {busy === key ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Trash2 size={15} aria-hidden />}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <aside className={`${shopCard} flex h-fit flex-col gap-4 p-5`}>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void cartAction("promo", { action: "promo", code: code.trim() });
          }}
        >
          <label htmlFor="promo" className="text-[13px] font-semibold text-muted">
            Discount code
          </label>
          <div className="flex gap-2">
            <input id="promo" className={`${shopInput} min-w-0 flex-1 uppercase`} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" maxLength={64} />
            <button type="submit" className={shopBtnSecondary} disabled={busy !== null}>
              {busy === "promo" ? "Applying" : "Apply"}
            </button>
          </div>
          {view.promo && !view.promo.ok && <ErrorLine>{view.promo.reason ?? "That code isn't valid"}</ErrorLine>}
          {view.promo?.ok && <p className="text-[13px] font-medium text-ink">Code {view.promo.code} applied.</p>}
        </form>

        <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 border-t border-line pt-4 text-[15px]">
          <dt className="text-muted">Subtotal</dt>
          <dd className="text-right tabular-nums">{money(view.subtotalCents, cur)}</dd>
          {view.discountCents > 0 && (
            <>
              <dt className="text-muted">Discount</dt>
              <dd className="text-right tabular-nums">−{money(view.discountCents, cur)}</dd>
            </>
          )}
          {view.taxCents > 0 && (
            <>
              <dt className="text-muted">Tax</dt>
              <dd className="text-right tabular-nums">{money(view.taxCents, cur)}</dd>
            </>
          )}
          <dt className="pt-1 text-[18px] font-bold">Total</dt>
          <dd className="pt-1 text-right text-[18px] font-bold tabular-nums">{money(view.totalCents, cur)}</dd>
        </dl>

        {needCaptcha && captcha && <CaptchaWidget config={captcha} onToken={setCaptchaToken} resetKey={captchaKey} />}
        {!paymentsReady && <ErrorLine>This store can&apos;t take payments yet. The store owner needs to connect Stripe before you can check out.</ErrorLine>}
        {view.blocker && <ErrorLine>{view.blocker}</ErrorLine>}
        {error && <ErrorLine>{error}</ErrorLine>}
        <button
          type="button"
          className={`${shopBtnPrimary} w-full`}
          onClick={checkout}
          disabled={busy !== null || !paymentsReady || !view.checkoutReady || (needCaptcha && !captchaToken)}
        >
          {busy === "checkout" ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Lock size={16} aria-hidden />}
          {busy === "checkout" ? "Going to checkout" : "Check out"}
        </button>
        <p className="text-[13px] text-muted">You&apos;ll pay on a secure Stripe page. Prices and stock are confirmed at checkout.</p>
      </aside>
    </div>
  );
}
