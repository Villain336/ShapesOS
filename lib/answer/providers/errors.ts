// ShapesOS — Phase 21A (WS=agentweb): classified search-provider failures.
// One provider failing never fails an answer; the engine reads `kind` to say why.

export type SearchErrorKind = "rate_limited" | "auth" | "unavailable" | "bad_response" | "network";

export class SearchProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: SearchErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

export function classifyStatus(provider: string, status: number): SearchProviderError {
  if (status === 429) return new SearchProviderError(provider, "rate_limited", `${provider} is rate limiting requests.`);
  if (status === 401 || status === 403) return new SearchProviderError(provider, "auth", `${provider} refused the API key.`);
  return new SearchProviderError(provider, "unavailable", `${provider} answered HTTP ${status}.`);
}

export const stripMarkup = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

export const isoOrUndefined = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};
