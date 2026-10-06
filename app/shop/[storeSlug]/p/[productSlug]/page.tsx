// ShapesOS — Phase 10 (store): public product page
// (/shop/[storeSlug]/p/[productSlug]). SSR with per-product metadata and
// JSON-LD Product/Offer (price, currency, availability, SKU). Unknown,
// unlisted or inactive products 404.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Package } from "lucide-react";
import { loadPublicListing } from "@/lib/ops/store/catalog";
import { getPublishedStore, siteOrigin } from "@/lib/ops/store/page-data";
import { availabilityUrl, fmtPrice } from "@/lib/ops/store/view";
import { AddToCart } from "@/components/store/AddToCart";
import { shopCard } from "@/components/store/styles";

type Props = PageProps<"/shop/[storeSlug]/p/[productSlug]">;

async function load(params: Props["params"]) {
  const { storeSlug, productSlug } = await params;
  const store = await getPublishedStore(storeSlug);
  const listing = await loadPublicListing(store, productSlug);
  if (!listing) notFound();
  return { store, listing };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { store, listing } = await load(params);
  const url = `/shop/${store.slug}/p/${listing.slug}`;
  const description = (listing.description ?? `${listing.title} from ${store.name}.`).replace(/\s+/g, " ").slice(0, 160);
  const image = listing.hasImage ? `/shop/${store.slug}/img/${listing.id}` : undefined;
  return {
    title: listing.title,
    description,
    alternates: { canonical: url },
    openGraph: { title: listing.title, description, url, ...(image ? { images: [{ url: image }] } : {}) },
  };
}

export default async function ProductPage({ params }: Props) {
  const { store, listing } = await load(params);
  const base = `/shop/${store.slug}`;
  const origin = siteOrigin() ?? "";
  const url = `${origin}${base}/p/${listing.slug}`;
  const image = listing.hasImage ? `${origin}${base}/img/${listing.id}` : undefined;
  const offer = (v: (typeof listing.variants)[number]) => ({
    "@type": "Offer",
    price: (v.priceCents / 100).toFixed(2),
    priceCurrency: store.currency,
    availability: availabilityUrl(v.available),
    url,
    ...(v.id ? { sku: v.sku, name: v.name } : {}),
  });
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: listing.title,
    sku: listing.sku,
    ...(listing.description ? { description: listing.description } : {}),
    ...(image ? { image } : {}),
    brand: { "@type": "Brand", name: store.name },
    offers: listing.variants.length === 1 ? offer(listing.variants[0]!) : listing.variants.map(offer),
  };
  const prices = listing.variants.map((v) => v.priceCents);
  const priceText =
    Math.min(...prices) === Math.max(...prices)
      ? fmtPrice(prices[0]!, store.currency)
      : `${fmtPrice(Math.min(...prices), store.currency)} – ${fmtPrice(Math.max(...prices), store.currency)}`;

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <Link href={base} className="mb-6 inline-flex items-center gap-1.5 text-[0.875rem] font-semibold text-muted hover:text-ink">
        <ArrowLeft size={16} aria-hidden /> All products
      </Link>
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <div className={`${shopCard} flex aspect-square items-center justify-center overflow-hidden`}>
          {listing.hasImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`${base}/img/${listing.id}`} alt={listing.title} className="h-full w-full object-cover" />
          ) : (
            <Package size={56} className="text-subtle" aria-hidden />
          )}
        </div>
        <div className="flex flex-col gap-5">
          <div>
            <h1 className="aos-heading">{listing.title}</h1>
            <p className="mt-2 text-[1.125rem] font-semibold tabular-nums">{priceText}</p>
            {store.taxRateId && <p className="mt-1 text-[0.8125rem] text-muted">Tax is added at checkout.</p>}
          </div>
          <AddToCart
            storeSlug={store.slug}
            productId={listing.productId}
            variants={listing.variants.map((v) => ({ id: v.id, name: v.name, priceLabel: fmtPrice(v.priceCents, store.currency), available: v.available }))}
          />
          {listing.description && <div className="whitespace-pre-line border-t border-line pt-5 text-[0.9375rem] leading-relaxed text-ink">{listing.description}</div>}
          <p className="font-mono text-[0.75rem] text-subtle">SKU {listing.sku}</p>
        </div>
      </div>
    </>
  );
}
