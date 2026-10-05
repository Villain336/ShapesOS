// ShapesOS — Phase 10 (store): public cart (/shop/[storeSlug]/cart).
// The first render is priced on the server from the signed cart cookie;
// changes go through /api/shop/[storeSlug]/cart. Not indexed.

import type { Metadata } from "next";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { publicCaptchaConfig } from "@/lib/auth/captcha";
import { priceCartFor, storePaymentsReady } from "@/lib/ops/store/catalog";
import { getCart, getPublishedStore } from "@/lib/ops/store/page-data";
import { cartView } from "@/lib/ops/store/view";
import { CartClient } from "@/components/store/CartClient";

export const metadata: Metadata = { title: "Cart", robots: { index: false, follow: false } };

export default async function CartPage({ params }: PageProps<"/shop/[storeSlug]/cart">) {
  const { storeSlug } = await params;
  const store = await getPublishedStore(storeSlug);
  const cart = await getCart(store);
  const [{ priced }, paymentsReady] = await Promise.all([
    withWorkspaceScope(store.workspaceId, (tx) => priceCartFor(tx, store, cart)),
    storePaymentsReady(store),
  ]);
  return (
    <>
      <h1 className="aos-heading mb-6">Your cart</h1>
      <CartClient storeSlug={store.slug} initial={cartView(cart, priced, store.currency)} captcha={publicCaptchaConfig()} paymentsReady={paymentsReady} />
    </>
  );
}
