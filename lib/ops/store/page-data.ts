// ShapesOS — Phase 10 (store): request-scoped loaders for the public
// /shop/[storeSlug] pages. React cache() dedupes the store lookup between
// the layout, the page and generateMetadata within one request.

import { cache } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cartCookieName, cartItemCount, readCart, type Cart } from "./cart";
import { resolvePublishedStore, type PublicStore } from "./catalog";

export const getPublishedStore = cache(async (slug: string): Promise<PublicStore> => {
  const store = await resolvePublishedStore(slug);
  if (!store) notFound();
  return store;
});

export async function getCart(store: PublicStore): Promise<Cart> {
  const jar = await cookies();
  return readCart(jar.get(cartCookieName(store.id))?.value, store.id);
}

export async function getCartCount(store: PublicStore): Promise<number> {
  return cartItemCount(await getCart(store));
}

/** Absolute origin for canonical URLs / JSON-LD (APP_URL, else NEXTAUTH_URL). */
export function siteOrigin(): string | null {
  for (const raw of [process.env.APP_URL, process.env.NEXTAUTH_URL]) {
    try {
      if (raw) return new URL(raw).origin;
    } catch {
      // not a URL
    }
  }
  return null;
}
