// ShapesOS — Phase 10 (store): public storefront shell (/shop/[storeSlug]).
// PUBLIC, unauthenticated, per workspace: only a PUBLISHED store renders
// (lib/ops/store/catalog.ts resolvePublishedStore → notFound otherwise).
// Agentic OS tokens on the canvas background; no app chrome.

import type { Metadata } from "next";
import Link from "next/link";
import { ShoppingBag } from "lucide-react";
import { getCartCount, getPublishedStore, siteOrigin } from "@/lib/ops/store/page-data";

export async function generateMetadata({ params }: LayoutProps<"/shop/[storeSlug]">): Promise<Metadata> {
  const { storeSlug } = await params;
  const store = await getPublishedStore(storeSlug);
  const origin = siteOrigin();
  return {
    title: { default: store.name, template: `%s — ${store.name}` },
    description: store.description?.slice(0, 160) ?? `Shop ${store.name} online.`,
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    openGraph: { siteName: store.name, type: "website" },
    robots: { index: true, follow: true },
  };
}

export default async function ShopLayout({ children, params }: LayoutProps<"/shop/[storeSlug]">) {
  const { storeSlug } = await params;
  const store = await getPublishedStore(storeSlug);
  const count = await getCartCount(store);
  const base = `/shop/${store.slug}`;
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
          <Link href={base} className="aos-subheading truncate rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
            {store.name}
          </Link>
          <Link
            href={`${base}/cart`}
            className="inline-flex h-control-sm items-center gap-2 rounded-full bg-paper px-4 text-[15px] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)]"
            aria-label={`Cart, ${count} item${count === 1 ? "" : "s"}`}
          >
            <ShoppingBag size={16} aria-hidden />
            Cart
            {count > 0 && <span className="rounded-full bg-ink px-2 text-[12px] font-semibold text-paper tabular-nums">{count}</span>}
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>
      <footer className="border-t border-line bg-paper">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-5 py-4 text-[13px] text-muted">
          <span>
            {store.name}
            {store.contactEmail && (
              <>
                {" · "}
                <a className="underline hover:text-ink" href={`mailto:${store.contactEmail}`}>
                  {store.contactEmail}
                </a>
              </>
            )}
          </span>
          <span>Payments are processed securely by Stripe.</span>
        </div>
      </footer>
    </div>
  );
}
