// Marketr — Phase 11 "Canvas": Pixabay stock image + video integration
// (integration #6, after Unsplash/Pexels).
// BYO-key pattern (same as the LLM and DataForSEO keys): PIXABAY_API_KEY lives
// on the host environment, is read server-side only, and is never exposed to
// the browser. Pixabay auth is a QUERY-STRING `key` parameter — the key is
// appended server-side; it must never appear in a browser-visible URL.
//
// OPEN ITEM 1 (docs/phase11/asset-api-survey.md §15) RESOLUTION:
// pixabay.com/api/docs was unreachable from the build environment (blocked),
// so the clause could not be re-verified. The brief mandates the CONSERVATIVE
// architecture in that case, and this module implements it:
//   → NO permanent hotlinking of Pixabay CDN URLs.
//   → Server downloads the chosen asset, caches it (24h per Pixabay's API
//     terms), and serves it from Marketr's own route
//     (/api/studio/pixabay/asset). Placed elements use THAT url as their src.
// The CDN URLs still appear transiently as search-grid thumbnails (never as
// permanent design sources), which matches "search → download → serve yourself".
//
// Two more Pixabay rules honored here:
//  - API responses cached 24h per the API terms (in-memory, process-local).
//  - ~100 requests per 60 seconds — an in-process sliding-window guard
//    answers 429 honestly before Pixabay has to.
// Pixabay does not guarantee model or property releases exist for
// people/logos/trademarks in images — the panel carries that disclaimer
// (marketing campaigns need it), see the PixabayTab in StockPhotosPanel.tsx.

export type PixabayMediaType = "image" | "video";
export type PixabayImageType = "photo" | "illustration" | "vector";

export interface PixabaySearchParams {
  q: string;
  page: number;
  perPage: number;
  type: PixabayMediaType;
  /** Only meaningful when type === "image". */
  imageType: PixabayImageType;
}

export interface PixabayAsset {
  id: number;
  /** Transient grid thumbnail (Pixabay CDN) — NOT a permanent source. */
  thumbUrl: string;
  /**
   * Permanent Marketr-served URL (/api/studio/pixabay/asset?t=...) that the
   * placed element uses as its src. Never a Pixabay CDN URL.
   */
  placeUrl: string;
  width: number;
  height: number;
  alt: string | null;
  /** Contributor display name (courtesy credit; attribution not required). */
  author: string;
  /** Pixabay page for the asset (courtesy credit link). */
  pageUrl: string;
  mediaType: PixabayMediaType;
  /** Seconds; video only. */
  duration?: number;
  /** Direct video file URL — stored in the element's custom bag for reference. */
  videoFile?: string;
}

export const PIXABAY_API_BASE = "https://pixabay.com/api/";
export const PIXABAY_VIDEO_API_BASE = "https://pixabay.com/api/videos/";
/** Pixabay caps per_page at 200; we cap lower to keep payloads small. */
export const MAX_PER_PAGE = 24;
export const DEFAULT_PER_PAGE = 12;
/** Pixabay API terms: cache API responses for 24 hours. */
export const RESPONSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Same 24h TTL for downloaded asset bytes served from our storage. */
export const ASSET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Refuse to download anything bigger than this (videos can be huge). */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** Pixabay's documented burst limit. */
export const RATE_LIMIT_PER_MINUTE = 100;

/** Only these hosts may be fetched by the asset route (SSRF guard). */
export const PIXABAY_CDN_HOST = "cdn.pixabay.com";

/** Honest unconfigured-key message. Names the env var; never its value. */
export const NOT_CONFIGURED_MESSAGE =
  "Stock media need a free Pixabay API key. Add PIXABAY_API_KEY in Settings → Providers, then try again.";

/** Courtesy credit line (Pixabay does not require attribution). */
export const PIXABAY_CREDIT_LINE = "Images and videos from Pixabay contributors";

/** Model/property-release disclaimer — must surface in the UI. */
export const RELEASE_DISCLAIMER =
  "Pixabay does not guarantee that model or property releases exist for the people, logos, or trademarks in an image. Check rights before using an asset in a paid client campaign.";

/** Server-side only: the API key never leaves the server. */
export function getPixabayApiKey(): string {
  return (process.env.PIXABAY_API_KEY ?? "").trim();
}

/** Status shape mirrors lib/providers providerStatus() for the Settings UI. */
export function pixabayStatus() {
  const configured = getPixabayApiKey().length > 0;
  return { name: "pixabay", isLive: configured, configured };
}

/** 400-class param failure; the route maps it straight to a JSON response. */
export class SearchParamError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "SearchParamError";
  }
}

/** 429-class rate-limit failure; the route maps it to a JSON 429. */
export class RateLimitError extends Error {
  readonly status = 429;
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
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

const IMAGE_TYPES: PixabayImageType[] = ["photo", "illustration", "vector"];

/** Validate/normalize ?q=&page=&per_page=&type=&image_type=. Throws SearchParamError (400). */
export function parseSearchParams(sp: URLSearchParams): PixabaySearchParams {
  const q = (sp.get("q") ?? "").trim();
  if (!q) throw new SearchParamError("Search query (q) is required.");
  if (q.length > 200) {
    throw new SearchParamError("Search query is too long (max 200 characters).");
  }
  const typeRaw = (sp.get("type") ?? "image").trim().toLowerCase();
  if (typeRaw !== "image" && typeRaw !== "video") {
    throw new SearchParamError('type must be "image" or "video".');
  }
  const imageTypeRaw = (sp.get("image_type") ?? "photo").trim().toLowerCase();
  if (!IMAGE_TYPES.includes(imageTypeRaw as PixabayImageType)) {
    throw new SearchParamError('image_type must be "photo", "illustration", or "vector".');
  }
  const page = parsePositiveInt(sp.get("page"), 1, "page");
  const perPage = Math.min(parsePositiveInt(sp.get("per_page"), DEFAULT_PER_PAGE, "per_page"), MAX_PER_PAGE);
  return {
    q,
    page,
    perPage,
    type: typeRaw as PixabayMediaType,
    imageType: imageTypeRaw as PixabayImageType,
  };
}

// ---------------------------------------------------------------------------
// No-hotlink machinery
// ---------------------------------------------------------------------------

/**
 * The NO-HOTLINK GUARD. A permanent design source is allowed only when it is
 * served by Marketr itself (/api/studio/pixabay/asset). Raw Pixabay CDN URLs
 * (https://cdn.pixabay.com/...) must NEVER be emitted as permanent sources —
 * they appear in search payloads only as transient thumbnails.
 */
export function isPermanentSourceAllowed(src: string): boolean {
  return src.startsWith("/api/studio/pixabay/asset");
}

/**
 * Encode a public Pixabay CDN URL into an opaque token for the asset route.
 * The token carries NO key material (the key is appended server-side at
 * fetch time; CDN file URLs need no key anyway).
 */
export function encodeAssetToken(sourceUrl: string): string {
  return Buffer.from(sourceUrl, "utf8").toString("base64url");
}

/**
 * Decode an asset token back to a URL, enforcing the CDN allowlist so the
 * asset route can never be abused as an open proxy. Returns null for
 * anything that is not a Pixabay CDN URL.
 */
export function decodeAssetToken(token: string): string | null {
  let url: string;
  try {
    url = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!url.startsWith("https://")) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host !== PIXABAY_CDN_HOST) return null;
  return url;
}

/** The Marketr-served URL a placed element uses as its src. */
export function buildAssetUrl(token: string): string {
  return `/api/studio/pixabay/asset?t=${token}`;
}

// ---------------------------------------------------------------------------
// Response mapping (CDN URLs appear here ONLY as transient thumbnails)
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Trim one Pixabay image hit. `webformatURL` becomes the grid thumbnail;
 * `largeImageURL` (fallback: webformatURL) is the source downloaded by the
 * asset route and served from Marketr's storage as the permanent source.
 */
export function mapPixabayImage(raw: unknown): PixabayAsset | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number") return null;
  const thumb = str(r.previewURL) ?? str(r.webformatURL);
  const source = str(r.largeImageURL) ?? str(r.webformatURL);
  if (!thumb || !source) return null;

  return {
    id: r.id,
    thumbUrl: thumb,
    placeUrl: buildAssetUrl(encodeAssetToken(source)),
    width: typeof r.imageWidth === "number" ? r.imageWidth : 0,
    height: typeof r.imageHeight === "number" ? r.imageHeight : 0,
    alt: str(r.tags),
    author: str(r.user)?.trim() || "Unknown contributor",
    pageUrl: str(r.pageURL) ?? "https://pixabay.com",
    mediaType: "image",
  };
}

function pickVideoVariant(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  // Prefer the smallest variant that is still presentable; keeps downloads sane.
  for (const key of ["small", "medium", "large", "tiny"] as const) {
    const variant = v[key];
    if (typeof variant === "object" && variant !== null) {
      const url = str((variant as Record<string, unknown>).url);
      if (url && url.startsWith("https://")) return url;
    }
  }
  return null;
}

/**
 * Trim one Pixabay video hit. The canvas has no video element type, so the
 * video's preview poster is what lands on the canvas — served through the
 * asset route (cached), with the direct video file URL + duration in the
 * element's custom bag for reference.
 */
export function mapPixabayVideo(raw: unknown): PixabayAsset | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number") return null;
  const thumb = str(r.previewURL);
  const videoFile = pickVideoVariant(r.videos);
  if (!thumb || !videoFile) return null;

  return {
    id: r.id,
    thumbUrl: thumb,
    placeUrl: buildAssetUrl(encodeAssetToken(thumb)),
    width: typeof r.imageWidth === "number" ? r.imageWidth : 0,
    height: typeof r.imageHeight === "number" ? r.imageHeight : 0,
    alt: str(r.tags),
    author: str(r.user)?.trim() || "Unknown contributor",
    pageUrl: str(r.pageURL) ?? "https://pixabay.com",
    mediaType: "video",
    duration: typeof r.duration === "number" ? r.duration : 0,
    videoFile,
  };
}

/** Unconfigured-key error payload. Never includes key material. */
export function notConfiguredError() {
  return {
    status: 400 as const,
    body: {
      error: NOT_CONFIGURED_MESSAGE,
      code: "pixabay_not_configured" as const,
    },
  };
}

/** Thrown by fetchPixabayMedia; status 0 = network failure, else HTTP. */
export class PixabayApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PixabayApiError";
    this.status = status;
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// 24h response cache (Pixabay API terms) + ~100 req/60s guard
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const RESPONSE_CACHE = new Map<string, CacheEntry<{ results: PixabayAsset[]; total: number }>>();
const MAX_RESPONSE_CACHE_ENTRIES = 500;

function responseCacheKey(params: PixabaySearchParams): string {
  return `${params.type}:${params.imageType}:${params.q.toLowerCase()}:${params.page}:${params.perPage}`;
}

/** Read the 24h response cache. Exported for tests. */
export function readResponseCache(params: PixabaySearchParams): { results: PixabayAsset[]; total: number } | null {
  const entry = RESPONSE_CACHE.get(responseCacheKey(params));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    RESPONSE_CACHE.delete(responseCacheKey(params));
    return null;
  }
  return entry.value;
}

function writeResponseCache(params: PixabaySearchParams, value: { results: PixabayAsset[]; total: number }): void {
  if (RESPONSE_CACHE.size >= MAX_RESPONSE_CACHE_ENTRIES) {
    const oldest = RESPONSE_CACHE.keys().next();
    if (!oldest.done) RESPONSE_CACHE.delete(oldest.value);
  }
  RESPONSE_CACHE.set(responseCacheKey(params), { value, expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS });
}

/** Clear the response cache. Exported for tests. */
export function clearResponseCache(): void {
  RESPONSE_CACHE.clear();
}

const REQUEST_TIMES = new Map<string, number[]>();

/**
 * Sliding-window rate guard: at most RATE_LIMIT_PER_MINUTE requests per
 * 60 seconds per workspace. Returns true when the request may proceed,
 * false when the caller should answer 429.
 */
export function checkRateLimit(workspaceId: string): boolean {
  const now = Date.now();
  const times = (REQUEST_TIMES.get(workspaceId) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= RATE_LIMIT_PER_MINUTE) {
    REQUEST_TIMES.set(workspaceId, times);
    return false;
  }
  times.push(now);
  REQUEST_TIMES.set(workspaceId, times);
  return true;
}

/** Clear rate-limit state. Exported for tests. */
export function clearRateLimit(): void {
  REQUEST_TIMES.clear();
}

/**
 * Server-side call to Pixabay image or video search. The API key is appended
 * to the query string HERE — it is never present in browser-visible URLs.
 * Successful responses are cached for 24h per the Pixabay API terms.
 * `fetchImpl` is injectable for tests; production passes the global fetch.
 * Never logs the API key.
 */
export async function fetchPixabayMedia(
  apiKey: string,
  params: PixabaySearchParams,
  fetchImpl: FetchImpl = fetch,
): Promise<{ results: PixabayAsset[]; total: number }> {
  const cached = readResponseCache(params);
  if (cached) return cached;

  const base = params.type === "video" ? PIXABAY_VIDEO_API_BASE : PIXABAY_API_BASE;
  const url =
    `${base}?key=${encodeURIComponent(apiKey)}` +
    `&q=${encodeURIComponent(params.q)}` +
    `&page=${params.page}&per_page=${params.perPage}` +
    (params.type === "image" ? `&image_type=${params.imageType}` : "");
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch {
    throw new PixabayApiError(0, "Could not reach Pixabay.");
  }
  if (!res.ok) {
    throw new PixabayApiError(res.status, `Pixabay request failed with HTTP ${res.status}.`);
  }
  const json = (await res.json()) as { hits?: unknown; totalHits?: unknown };
  const results = Array.isArray(json.hits)
    ? json.hits
        .map(params.type === "video" ? mapPixabayVideo : mapPixabayImage)
        .filter((a): a is PixabayAsset => a !== null)
    : [];
  const total = typeof json.totalHits === "number" ? json.totalHits : results.length;
  const payload = { results, total };
  writeResponseCache(params, payload);
  return payload;
}

// ---------------------------------------------------------------------------
// Downloaded-asset cache (server-side storage, 24h TTL)
// ---------------------------------------------------------------------------

interface AssetCacheEntry {
  bytes: Buffer;
  mime: string;
  expiresAt: number;
}

const ASSET_CACHE = new Map<string, AssetCacheEntry>();
const MAX_ASSET_CACHE_ENTRIES = 100;

function mimeForUrl(url: string): string {
  const lower = url.toLowerCase().split("?")[0];
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp4")) return "video/mp4";
  return "image/jpeg";
}

/**
 * Download a Pixabay CDN asset server-side and cache the bytes for 24h.
 * Placed elements' src points at /api/studio/pixabay/asset, which serves
 * from this cache — Pixabay CDN URLs are never permanent design sources.
 * Exported for the asset route and for tests.
 */
export async function getCachedAsset(
  sourceUrl: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ bytes: Buffer; mime: string }> {
  const entry = ASSET_CACHE.get(sourceUrl);
  if (entry && Date.now() <= entry.expiresAt) return { bytes: entry.bytes, mime: entry.mime };
  if (entry) ASSET_CACHE.delete(sourceUrl);

  let res: Response;
  try {
    res = await fetchImpl(sourceUrl);
  } catch {
    throw new PixabayApiError(0, "Could not download the Pixabay asset.");
  }
  if (!res.ok) {
    throw new PixabayApiError(res.status, `Pixabay asset download failed with HTTP ${res.status}.`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new PixabayApiError(413, "The Pixabay asset is too large to cache (max 25 MB).");
  }
  const mime = mimeForUrl(sourceUrl);

  if (ASSET_CACHE.size >= MAX_ASSET_CACHE_ENTRIES) {
    const oldest = ASSET_CACHE.keys().next();
    if (!oldest.done) ASSET_CACHE.delete(oldest.value);
  }
  ASSET_CACHE.set(sourceUrl, { bytes, mime, expiresAt: Date.now() + ASSET_CACHE_TTL_MS });
  return { bytes, mime };
}

/** Clear the asset cache. Exported for tests. */
export function clearAssetCache(): void {
  ASSET_CACHE.clear();
}
