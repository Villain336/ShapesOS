// Marketr — Wave 2 context.dev slice 1+3: credit costs per operation.
//
// Pure table. Costs verified 2026-10-01 against docs.context.dev/account/credits
// (official): Scrape 1, Map 1 (2 with search), Brand 10, Styleguide 10,
// People 20, Answers fast 10 / ultra 100 (charged on success AND partial),
// prefetch 0. AI products 10+. Unknown operations fail closed — the caller
// must name a known operation, never a guessed cost.

export type ContextDevOperation =
  | "scrape_markdown"
  | "scrape_html"
  | "scrape_images"
  | "crawl_sitemap"
  | "brand_retrieve"
  | "brand_prefetch"
  | "ai_products"
  | "answers_fast"
  | "answers_ultra";

export const CONTEXTDEV_CREDIT_COSTS: Record<ContextDevOperation, number> = {
  scrape_markdown: 1,
  scrape_html: 1,
  scrape_images: 1,
  crawl_sitemap: 1,
  brand_retrieve: 10,
  brand_prefetch: 0,
  ai_products: 10,
  answers_fast: 10,
  answers_ultra: 100,
};

/** Credits one call of the operation costs. Throws on unknown operations (fail closed). */
export function contextDevCreditsFor(operation: string): number {
  const cost = (CONTEXTDEV_CREDIT_COSTS as Record<string, number | undefined>)[operation];
  if (cost === undefined) {
    throw new Error(`contextdev: unknown operation "${operation}" — refusing to guess a cost`);
  }
  return cost;
}

/** All known operations, for UI dropdowns and validation. */
export function knownContextDevOperations(): ContextDevOperation[] {
  return Object.keys(CONTEXTDEV_CREDIT_COSTS) as ContextDevOperation[];
}
