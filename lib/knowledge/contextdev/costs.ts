// Marketr — Wave 2 context.dev slice 1: credit costs per operation.
//
// Pure table. Costs verified 2026-10-01 from the n8n community node's README
// (fredfrom/n8n-nodes-context-dev): Web 1 credit/call, Brand 10/call,
// AI extraction 10+/call, Screenshot 1/call, Transaction 1/call,
// brand prefetch 0 credits. Unknown operations fail closed — the caller must
// name a known operation, never a guessed cost.

export type ContextDevOperation =
  | "scrape_markdown"
  | "scrape_html"
  | "scrape_images"
  | "crawl_sitemap"
  | "brand_retrieve"
  | "brand_prefetch"
  | "ai_products";

export const CONTEXTDEV_CREDIT_COSTS: Record<ContextDevOperation, number> = {
  scrape_markdown: 1,
  scrape_html: 1,
  scrape_images: 1,
  crawl_sitemap: 1,
  brand_retrieve: 10,
  brand_prefetch: 0,
  ai_products: 10,
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
