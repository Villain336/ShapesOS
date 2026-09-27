// Marketr — Phase 11 "Canvas": Unsplash stock-photo integration.
// BYO-key pattern (same as the LLM and DataForSEO keys): UNSPLASH_ACCESS_KEY
// lives on the host environment, is read server-side only, and is never
// exposed to the browser. No key → loud honest error, never fake photos.
// Photographer attribution is preserved end-to-end per Unsplash API
// guidelines and travels in the placed element's `custom` bag.

export interface StockPhoto {
  id: string;
  urls: { small: string; regular: string };
  width: number;
  height: number;
  /** alt_description; null when Unsplash has none. */
  alt: string | null;
  /** Photographer display name — required for attribution. */
  photographer: string;
  /** Photographer profile URL — required for attribution. */
  photographerUrl: string;
}

export interface StockSearchParams {
  q: string;
  page: number;
  perPage: number;
}

export const UNSPLASH_API_BASE = "https://api.unsplash.com";
/** Unsplash caps search results at 30/page; we cap lower to keep payloads small. */
export const MAX_PER_PAGE = 24;
export const DEFAULT_PER_PAGE = 12;

/** Honest unconfigured-key message. Names the env var; never its value. */
export const NOT_CONFIGURED_MESSAGE =
  "Stock photos need a free Unsplash API key. Add UNSPLASH_ACCESS_KEY in Settings → Providers, then try again.";

/** Server-side only: the access key never leaves the server. */
export function getUnsplashAccessKey(): string {
  return (process.env.UNSPLASH_ACCESS_KEY ?? "").trim();
}

/** Status shape mirrors lib/providers providerStatus() for the Settings UI. */
export function unsplashStatus() {
  const configured = getUnsplashAccessKey().length > 0;
  return { name: "unsplash", isLive: configured, configured };
}

/** 400-class param failure; the route maps it straight to a JSON response. */
export class SearchParamError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "SearchParamError";
  }
}

function parsePositiveInt(raw: string | null, fallback: number, label: string): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new SearchParamError(`${label} must be a positive integer.`);
  }
  return n;
}

/** Validate/normalize ?q=&page=&per_page=. Throws SearchParamError (400). */
export function parseSearchParams(sp: URLSearchParams): StockSearchParams {
  const q = (sp.get("q") ?? "").trim();
  if (!q) throw new SearchParamError("Search query (q) is required.");
  if (q.length > 200) {
    throw new SearchParamError("Search query is too long (max 200 characters).");
  }
  const page = parsePositiveInt(sp.get("page"), 1, "page");
  const perPage = Math.min(parsePositiveInt(sp.get("per_page"), DEFAULT_PER_PAGE, "per_page"), MAX_PER_PAGE);
  return { q, page, perPage };
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Trim one Unsplash photo to the documented shape, keeping the photographer
 * name + profile URL so attribution is never dropped downstream.
 * Returns null for payloads missing anything needed to render the photo.
 */
export function mapUnsplashPhoto(raw: unknown): StockPhoto | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const urls = typeof r.urls === "object" && r.urls !== null ? (r.urls as Record<string, unknown>) : null;
  const small = urls ? str(urls.small) : null;
  const regular = urls ? str(urls.regular) : null;
  if (!id || !small || !regular) return null;

  const user = typeof r.user === "object" && r.user !== null ? (r.user as Record<string, unknown>) : null;
  const links = user && typeof user.links === "object" && user.links !== null
    ? (user.links as Record<string, unknown>)
    : null;
  const photographer = user && str(user.name)?.trim() ? (str(user.name) as string).trim() : "Unknown photographer";
  const photographerUrl = links ? (str(links.html) ?? "https://unsplash.com") : "https://unsplash.com";

  return {
    id,
    urls: { small, regular },
    width: typeof r.width === "number" ? r.width : 0,
    height: typeof r.height === "number" ? r.height : 0,
    alt: str(r.alt_description),
    photographer,
    photographerUrl,
  };
}

/** Unconfigured-key error payload. Never includes key material. */
export function notConfiguredError() {
  return {
    status: 400 as const,
    body: {
      error: NOT_CONFIGURED_MESSAGE,
      code: "unsplash_not_configured" as const,
    },
  };
}

/** Thrown by fetchUnsplashPhotos; status 0 = network failure, else HTTP. */
export class UnsplashApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UnsplashApiError";
    this.status = status;
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Server-side call to Unsplash Search Photos. `fetchImpl` is injectable for
 * tests; production passes the global fetch. Never logs the access key.
 */
export async function fetchUnsplashPhotos(
  accessKey: string,
  params: StockSearchParams,
  fetchImpl: FetchImpl = fetch,
): Promise<{ results: StockPhoto[]; total: number }> {
  const url =
    `${UNSPLASH_API_BASE}/search/photos?query=${encodeURIComponent(params.q)}` +
    `&page=${params.page}&per_page=${params.perPage}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Client-ID ${accessKey}`, "Accept-Version": "v1" },
    });
  } catch {
    throw new UnsplashApiError(0, "Could not reach Unsplash.");
  }
  if (!res.ok) {
    throw new UnsplashApiError(res.status, `Unsplash request failed with HTTP ${res.status}.`);
  }
  const json = (await res.json()) as { results?: unknown; total?: unknown };
  const results = Array.isArray(json.results)
    ? json.results.map(mapUnsplashPhoto).filter((p): p is StockPhoto => p !== null)
    : [];
  const total = typeof json.total === "number" ? json.total : results.length;
  return { results, total };
}
