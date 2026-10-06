// ShapesOS — Phase 10 (store): after Stripe Checkout
// (/shop/[storeSlug]/thanks?session_id=cs_…). The session id Stripe appends
// is the capability: it shows that order's label, state and total only.
// "Confirmed" appears once the signed webhook has recorded the payment —
// this page never marks anything paid itself. Not indexed.

import type { Metadata } from "next";
import Link from "next/link";
import { orderForSession } from "@/lib/ops/store/catalog";
import { getPublishedStore } from "@/lib/ops/store/page-data";
import { fmtPrice } from "@/lib/ops/store/view";
import { ClearCartOnce } from "@/components/store/ClearCartOnce";
import { shopBtnSecondary, shopCard } from "@/components/store/styles";

export const metadata: Metadata = { title: "Thank you", robots: { index: false, follow: false } };

export default async function ThanksPage({ params, searchParams }: PageProps<"/shop/[storeSlug]/thanks">) {
  const { storeSlug } = await params;
  const sp = await searchParams;
  const store = await getPublishedStore(storeSlug);
  const sessionId = typeof sp.session_id === "string" ? sp.session_id : "";
  const order = sessionId ? await orderForSession(store, sessionId) : null;
  const confirmed = order && (order.status === "confirmed" || order.status === "fulfilled");

  return (
    <div className={`${shopCard} mx-auto flex max-w-xl flex-col gap-3 p-8`}>
      {order && <ClearCartOnce storeSlug={store.slug} />}
      <h1 className="aos-heading">{!order ? "We couldn't find that order" : confirmed ? "Thank you — your order is confirmed" : "Thank you — we're confirming your payment"}</h1>
      {order ? (
        <>
          <p className="text-[0.9375rem] text-muted">
            Order <span className="font-mono text-ink">{order.label}</span> · {fmtPrice(order.totalCents, store.currency)}
          </p>
          <p className="text-[0.9375rem]">
            {confirmed
              ? "Your payment was received. A receipt is on its way from Stripe."
              : order.status === "cancelled"
                ? "This checkout was cancelled or expired, and no payment was taken."
                : "Stripe is confirming your payment. This page shows the update once it arrives — refresh in a moment."}
          </p>
        </>
      ) : (
        <p className="text-[0.9375rem] text-muted">If you just paid, your receipt from Stripe is the record of your purchase.</p>
      )}
      <div className="pt-2">
        <Link href={`/shop/${store.slug}`} className={shopBtnSecondary}>
          Keep shopping
        </Link>
      </div>
    </div>
  );
}
