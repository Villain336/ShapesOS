// ShapesOS — Phase 10 (store): public catalogue (/shop/[storeSlug]).
// Listed listings of active products, with prices and stock read from the
// database at request time (SSR). JSON-LD ItemList for search engines.

import type { Metadata } from "next";
import Link from "next/link";
import { Package } from "lucide-react";
import { loadPublicListings } from "@/lib/ops/store/catalog";
import { getPublishedStore } from "@/lib/ops/store/page-data";
import { fmtPrice } from "@/lib/ops/store/view";
import { shopCard, shopChip, stockLabel } from "@/components/store/styles";

export async function generateMetadata({ params }: PageProps<"/shop/[storeSlug]">): Promise<Metadata> {
  const { storeSlug } = await params;
  const store = await getPublishedStore(storeSlug);
  return {
    title: { absolute: store.name },
    alternates: { canonical: `/shop/${store.slug}` },
    openGraph: { title: store.name, description: store.description ?? undefined, url: `/shop/${store.slug}` },
  };
}

export default async function CataloguePage({ params }: PageProps<"/shop/[storeSlug]">) {
  const { storeSlug } = await params;
  const store = await getPublishedStore(storeSlug);
  const listings = await loadPublicListings(store);
  const base = `/shop/${store.slug}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: store.name,
    itemListElement: listings.map((l, i) => ({ "@type": "ListItem", position: i + 1, url: `${base}/p/${l.slug}`, name: l.title })),
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <div className="mb-8 max-w-2xl">
        <h1 className="aos-display">{store.name}</h1>
        {store.description && <p className="mt-2 whitespace-pre-line text-[0.9375rem] text-muted">{store.description}</p>}
      </div>
      {listings.length === 0 ? (
        <div className={`${shopCard} flex flex-col items-center gap-2 px-6 py-16 text-center`}>
          <Package size={28} className="text-subtle" aria-hidden />
          <p className="text-[0.9375rem] font-semibold">Nothing for sale yet</p>
          <p className="text-[0.875rem] text-muted">Check back soon.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((l) => {
            const multi = l.variants.length > 1 && new Set(l.variants.map((v) => v.priceCents)).size > 1;
            return (
              <li key={l.id}>
                <Link
                  href={`${base}/p/${l.slug}`}
                  className={`${shopCard} group flex h-full flex-col overflow-hidden transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)]`}
                >
                  <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-canvas">
                    {l.hasImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`${base}/img/${l.id}`} alt={l.title} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <Package size={36} className="text-subtle" aria-hidden />
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <h2 className="text-[0.9375rem] font-semibold leading-snug">{l.title}</h2>
                    <div className="mt-auto flex items-center justify-between gap-2">
                      <span className="text-[0.9375rem] font-semibold tabular-nums">
                        {multi ? "From " : ""}
                        {fmtPrice(l.fromPriceCents, store.currency)}
                      </span>
                      <span className={shopChip}>{stockLabel(l.available)}</span>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
