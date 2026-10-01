// Marketr — Wave 2 context.dev slice 1: Context.dev REST API client.
//
// Pure network layer: no Prisma, no Next.js imports. fetchImpl is injectable
// so tests run against a mocked Context.dev API — no live API key exists, so
// the mock path is the verified path.
//
// Endpoint paths + auth verified 2026-10-01 against the n8n community node
// source (fredfrom/n8n-nodes-context-dev): base URL https://api.context.dev,
// "/v1" appended by the caller (the node's own convention), auth via
// `Authorization: Bearer <apiKey>`. Docs: https://docs.context.dev.
//
// Capabilities used: web scrape (markdown/html/images), sitemap crawl,
// brand retrieve (by domain/email/name), brand prefetch, AI product
// extraction. Monitors/Answers/Batches are covered in later slices against
// docs.context.dev.
//
// The API key is never logged — errors carry codes only.

export const CONTEXTDEV_BASE_URL = "https://api.context.dev";
export const CONTEXTDEV_API_VERSION = "v1";

export type ContextDevErrorCode =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR";

export class ContextDevError extends Error {
  readonly code: ContextDevErrorCode;
  readonly status?: number;
  constructor(code: ContextDevErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ContextDevError";
    this.code = code;
    this.status = status;
  }
}

export interface ContextDevAuth {
  /** Context.dev API key. Never logged — errors carry codes only. */
  apiKey: string;
  /** Override for staging. Defaults to https://api.context.dev. */
  baseUrl?: string;
}

export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

function apiUrl(auth: ContextDevAuth, path: string): string {
  const base = (auth.baseUrl ?? CONTEXTDEV_BASE_URL).replace(/\/+$/, "");
  return `${base}/${CONTEXTDEV_API_VERSION}${path}`;
}

function withQuery(url: string, params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

async function request<T>(
  auth: ContextDevAuth,
  fetchImpl: FetchImpl,
  method: "GET" | "POST",
  path: string,
  opts: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: Record<string, unknown>;
  } = {},
): Promise<T> {
  if (!auth.apiKey || !auth.apiKey.trim()) {
    throw new ContextDevError("AUTH_FAILED", "Context.dev API key is missing");
  }
  const url = withQuery(apiUrl(auth, path), opts.query ?? {});
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${auth.apiKey}`,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (err) {
    throw new ContextDevError(
      "NETWORK_ERROR",
      `Context.dev request failed: ${err instanceof Error ? err.message : "network error"}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ContextDevError("AUTH_FAILED", "Context.dev rejected the API key", res.status);
  }
  if (res.status === 429) {
    throw new ContextDevError("RATE_LIMITED", "Context.dev rate limit hit — back off and retry", 429);
  }
  if (res.status === 404) {
    throw new ContextDevError("NOT_FOUND", "Context.dev endpoint not found", 404);
  }
  if (res.status >= 400 && res.status < 500) {
    throw new ContextDevError("BAD_REQUEST", `Context.dev rejected the request (${res.status})`, res.status);
  }
  if (res.status >= 500) {
    throw new ContextDevError("UPSTREAM_ERROR", `Context.dev upstream error (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

// ── Result shapes (defensive: the vendor may add fields) ────────────────────

export interface ScrapeMarkdownResult {
  markdown: string;
  title?: string;
  description?: string;
}

export interface BrandLogo {
  url: string;
  variant?: string;
}

export interface BrandProfile {
  domain: string;
  name?: string;
  colors?: string[];
  fonts?: string[];
  logos?: BrandLogo[];
  socials?: Record<string, string>;
  industryCodes?: string[];
  raw: unknown;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

function normalizeBrandProfile(domain: string, json: unknown): BrandProfile {
  const j = (json ?? {}) as Record<string, unknown>;
  const brand = (j.brand ?? j) as Record<string, unknown>;
  const logosRaw = brand.logos ?? brand.logo;
  const logos: BrandLogo[] | undefined = Array.isArray(logosRaw)
    ? logosRaw
        .map((l) =>
          typeof l === "string"
            ? { url: l }
            : l && typeof l === "object" && typeof (l as { url?: unknown }).url === "string"
              ? { url: (l as { url: string }).url, variant: typeof (l as { variant?: unknown }).variant === "string" ? ((l as { variant?: string }).variant as string) : undefined }
              : null,
        )
        .filter((l): l is BrandLogo => l !== null)
    : undefined;
  return {
    domain,
    name: typeof brand.name === "string" ? brand.name : undefined,
    colors: asStringArray(brand.colors ?? brand.colorPalette),
    fonts: asStringArray(brand.fonts ?? brand.fontFamilies),
    logos,
    socials:
      brand.socials && typeof brand.socials === "object"
        ? (brand.socials as Record<string, string>)
        : undefined,
    industryCodes: asStringArray(brand.naics ?? brand.industryCodes ?? brand.sic),
    raw: json,
  };
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface ScrapeOptions {
  includeLinks?: boolean;
  includeImages?: boolean;
  shortenBase64Images?: boolean;
}

export interface SitemapOptions {
  maxLinks?: number;
}

export interface BrandRetrieveOptions {
  forceLanguage?: string;
  maxSpeed?: boolean;
  timeoutMs?: number;
}

export function createContextDevClient(auth: ContextDevAuth, fetchImpl: FetchImpl = fetch) {
  return {
    /** Scrape a URL to clean markdown. 1 credit/call. */
    async scrapeMarkdown(url: string, opts: ScrapeOptions = {}): Promise<ScrapeMarkdownResult> {
      if (!url.trim()) throw new ContextDevError("BAD_REQUEST", "scrapeMarkdown requires a URL");
      const json = await request<Record<string, unknown>>(auth, fetchImpl, "GET", "/web/scrape/markdown", {
        query: {
          url,
          includeLinks: opts.includeLinks,
          includeImages: opts.includeImages,
          shortenBase64Images: opts.shortenBase64Images,
        },
      });
      const markdown =
        typeof json.markdown === "string"
          ? json.markdown
          : typeof (json.data as Record<string, unknown> | undefined)?.markdown === "string"
            ? ((json.data as Record<string, unknown>).markdown as string)
            : "";
      const metadata = (json.metadata ?? {}) as Record<string, unknown>;
      return {
        markdown,
        title: typeof metadata.title === "string" ? metadata.title : undefined,
        description: typeof metadata.description === "string" ? metadata.description : undefined,
      };
    },

    /** Scrape a URL to rendered HTML. 1 credit/call. */
    async scrapeHtml(url: string): Promise<{ html: string }> {
      if (!url.trim()) throw new ContextDevError("BAD_REQUEST", "scrapeHtml requires a URL");
      const json = await request<Record<string, unknown>>(auth, fetchImpl, "GET", "/web/scrape/html", {
        query: { url },
      });
      return { html: typeof json.html === "string" ? json.html : "" };
    },

    /** List image URLs found on a page. 1 credit/call. */
    async scrapeImages(url: string): Promise<{ images: string[] }> {
      if (!url.trim()) throw new ContextDevError("BAD_REQUEST", "scrapeImages requires a URL");
      const json = await request<Record<string, unknown>>(auth, fetchImpl, "GET", "/web/scrape/images", {
        query: { url },
      });
      return { images: asStringArray(json.images) ?? [] };
    },

    /** Crawl a sitemap and return discovered URLs. 1 credit/call. */
    async crawlSitemap(domain: string, opts: SitemapOptions = {}): Promise<{ urls: string[] }> {
      const d = domain.trim().toLowerCase();
      if (!d) throw new ContextDevError("BAD_REQUEST", "crawlSitemap requires a domain");
      const json = await request<Record<string, unknown>>(auth, fetchImpl, "GET", "/web/scrape/sitemap", {
        query: { domain: d, maxLinks: opts.maxLinks },
      });
      // Accept { urls: [...] } or { links: [{ url }] }.
      const direct = asStringArray(json.urls);
      if (direct) return { urls: direct };
      const links = json.links;
      if (Array.isArray(links)) {
        const urls = links
          .map((l) => (l && typeof l === "object" ? (l as { url?: unknown }).url : null))
          .filter((u): u is string => typeof u === "string");
        return { urls };
      }
      return { urls: [] };
    },

    /** Full brand profile by domain: logos, colors, fonts, socials, industry codes. 10 credits/call. */
    async getBrandByDomain(domain: string, opts: BrandRetrieveOptions = {}): Promise<BrandProfile> {
      const d = domain.trim().toLowerCase();
      if (!d) throw new ContextDevError("BAD_REQUEST", "getBrandByDomain requires a domain");
      const json = await request<unknown>(auth, fetchImpl, "GET", "/brand/retrieve", {
        query: {
          domain: d,
          force_language: opts.forceLanguage,
          maxSpeed: opts.maxSpeed,
          timeoutMS: opts.timeoutMs,
        },
      });
      return normalizeBrandProfile(d, json);
    },

    /** Brand profile by work email (no free providers). 10 credits/call. */
    async getBrandByEmail(email: string): Promise<BrandProfile> {
      const e = email.trim().toLowerCase();
      if (!e || !e.includes("@")) throw new ContextDevError("BAD_REQUEST", "getBrandByEmail requires a valid email");
      const json = await request<unknown>(auth, fetchImpl, "GET", "/brand/retrieve-by-email", {
        query: { email: e },
      });
      return normalizeBrandProfile(e.split("@")[1] ?? e, json);
    },

    /** Brand profile by company name. 10 credits/call. */
    async getBrandByName(
      name: string,
      opts: { countryCode?: string } & BrandRetrieveOptions = {},
    ): Promise<BrandProfile> {
      const n = name.trim();
      if (n.length < 3) throw new ContextDevError("BAD_REQUEST", "getBrandByName requires a company name (3+ chars)");
      const json = await request<unknown>(auth, fetchImpl, "GET", "/brand/retrieve-by-name", {
        query: {
          name: n,
          country_gl: opts.countryCode,
          force_language: opts.forceLanguage,
          maxSpeed: opts.maxSpeed,
          timeoutMS: opts.timeoutMs,
        },
      });
      return normalizeBrandProfile(n, json);
    },

    /** Warm the brand cache for a domain. 0 credits. */
    async prefetchBrand(domain: string): Promise<{ ok: boolean }> {
      const d = domain.trim().toLowerCase();
      if (!d) throw new ContextDevError("BAD_REQUEST", "prefetchBrand requires a domain");
      await request<unknown>(auth, fetchImpl, "POST", "/brand/prefetch", { body: { domain: d } });
      return { ok: true };
    },

    /** AI product extraction for a domain. 10+ credits/call. */
    async extractAiProducts(
      domain: string,
      opts: { maxProducts?: number } = {},
    ): Promise<{ products: unknown[] }> {
      const d = domain.trim().toLowerCase();
      if (!d) throw new ContextDevError("BAD_REQUEST", "extractAiProducts requires a domain");
      const json = await request<Record<string, unknown>>(auth, fetchImpl, "POST", "/brand/ai/products", {
        body: { domain: d, maxProducts: opts.maxProducts ?? 10 },
      });
      const products = Array.isArray(json.products) ? json.products : [];
      return { products };
    },
  };
}

export type ContextDevClient = ReturnType<typeof createContextDevClient>;
