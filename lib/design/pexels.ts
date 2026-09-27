// Marketr — Phase 11 "Canvas": Pexels stock photo + video integration
// (integration #6, after Unsplash).
// BYO-key pattern (same as the LLM and DataForSEO keys): PEXELS_API_KEY lives
// on the host environment, is read server-side only, and is never exposed to
// the browser. No key → loud honest error, never fake media.
// Pexels API terms REQUIRE attribution: a "Photos provided by Pexels" credit
// wherever API results are used, plus photographer credit "when possible".
// Both travel in the placed element's `custom` bag, and the panel carries the
// "Photos provided by Pexels" footer. Hotlinking the images.pexels.com CDN
// URLs is the intended pattern (Pexels does not prohibit it), so the
// Unsplash-style "hotlink in canvas, export on flatten" flow applies.

export interface PexelsPhoto {
  id: number;
  urls: { small: string; medium: string; large: string };
  width: number;
  height: number;
  /** alt text; null when Pexels has none. */
  alt: string | null;
  /** Photographer display name — required for attribution. */
  photographer: string;
  /** Photographer profile URL — required for attribution. */
  photographerUrl: string;
}

export interface PexelsVideoFile {
  link: string;
  width: number;
  height: number;
  quality: string;
}

export interface PexelsVideo {
  id: number;
  /** Preview/poster image (images.pexels.com) — what lands on the canvas. */
  preview: string;
  width: number;
  height: number;
  /** Duration in seconds. */
  duration: number;
  /** Chosen direct .mp4 link; stored in the element's custom bag for reference. */
  videoFile: string;
  videographer: string;
  videographerUrl: string;
}

export type PexelsMediaType = "photo" | "video";

export interface PexelsSearchParams {
  q: string;
  page: number;
  perPage: number;
  type: PexelsMediaType;
}

export const PEXELS_API_BASE = "https://api.pexels.com";
/** Pexels caps search at 80/page; we cap lower to keep payloads small. */
export const MAX_PER_PAGE = 24;
export const DEFAULT_PER_PAGE = 12;

/** Honest unconfigured-key message. Names the env var; never its value. */
export const NOT_CONFIGURED_MESSAGE =
  "Stock media need a free Pexels API key. Add PEXELS_API_KEY in Settings → Providers, then try again.";

/** Panel footer credit — required by the Pexels API terms. */
export const PEXELS_ATTRIBUTION_LINE = "Photos and videos provided by Pexels";

/** Server-side only: the API key never leaves the server. */
export function getPexelsApiKey(): string {
  return (process.env.PEXELS_API_KEY ?? "").trim();
}

/** Status shape mirrors lib/providers providerStatus() for the Settings UI. */
export function pexelsStatus() {
  const configured = getPexelsApiKey().length > 0;
  return { name: "pexels", isLive: configured, configured };
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

/** Validate/normalize ?q=&page=&per_page=&type=. Throws SearchParamError (400). */
export function parseSearchParams(sp: URLSearchParams): PexelsSearchParams {
  const q = (sp.get("q") ?? "").trim();
  if (!q) throw new SearchParamError("Search query (q) is required.");
  if (q.length > 200) {
    throw new SearchParamError("Search query is too long (max 200 characters).");
  }
  const typeRaw = (sp.get("type") ?? "photo").trim().toLowerCase();
  if (typeRaw !== "photo" && typeRaw !== "video") {
    throw new SearchParamError('type must be "photo" or "video".');
  }
  const page = parsePositiveInt(sp.get("page"), 1, "page");
  const perPage = Math.min(parsePositiveInt(sp.get("per_page"), DEFAULT_PER_PAGE, "per_page"), MAX_PER_PAGE);
  return { q, page, perPage, type: typeRaw };
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Trim one Pexels photo to the documented shape, keeping the photographer
 * name + profile URL so attribution is never dropped downstream.
 * Returns null for payloads missing anything needed to render the photo.
 */
export function mapPexelsPhoto(raw: unknown): PexelsPhoto | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number") return null;
  const src = typeof r.src === "object" && r.src !== null ? (r.src as Record<string, unknown>) : null;
  const small = src ? str(src.small) : null;
  const medium = src ? str(src.medium) : null;
  const large = src ? str(src.large) : null;
  if (!small || !medium || !large) return null;

  const photographer =
    str(r.photographer)?.trim() || "Unknown photographer";
  const photographerUrl = str(r.photographer_url) ?? "https://www.pexels.com";

  return {
    id: r.id,
    urls: { small, medium, large },
    width: typeof r.width === "number" ? r.width : 0,
    height: typeof r.height === "number" ? r.height : 0,
    alt: str(r.alt),
    photographer,
    photographerUrl,
  };
}

/**
 * Pick the best direct .mp4 file from a Pexels video's video_files list:
 * the widest mp4 at or below 1920px (keeps panel payloads and canvas
 * hotlinking sane). Returns null when no usable mp4 file exists.
 */
export function pickVideoFile(raw: unknown): PexelsVideoFile | null {
  if (!Array.isArray(raw)) return null;
  let best: PexelsVideoFile | null = null;
  for (const f of raw) {
    if (typeof f !== "object" || f === null) continue;
    const rec = f as Record<string, unknown>;
    const link = str(rec.link);
    if (typeof rec.width !== "number" || typeof rec.height !== "number" || !link) continue;
    if (rec.file_type !== "video/mp4" || !link.endsWith(".mp4")) continue;
    if (rec.width > 1920) continue;
    if (!best || rec.width > best.width) {
      best = { link, width: rec.width, height: rec.height, quality: str(rec.quality) ?? "" };
    }
  }
  return best;
}

/**
 * Trim one Pexels video to the documented shape. The canvas has no video
 * element type, so videos are inserted as their preview poster image, with
 * the direct .mp4 link + duration in the element's custom bag.
 * Returns null for payloads missing anything needed to render the poster.
 */
export function mapPexelsVideo(raw: unknown): PexelsVideo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number") return null;
  const image = str(r.image);
  const videoFile = pickVideoFile(r.video_files);
  if (!image || !videoFile) return null;

  const user = typeof r.user === "object" && r.user !== null ? (r.user as Record<string, unknown>) : null;
  const videographerRaw = user ? str(user.name)?.trim() : null;

  return {
    id: r.id,
    preview: image,
    width: typeof r.width === "number" ? r.width : 0,
    height: typeof r.height === "number" ? r.height : 0,
    duration: typeof r.duration === "number" ? r.duration : 0,
    videoFile: videoFile.link,
    videographer: videographerRaw || "Unknown videographer",
    videographerUrl: user ? (str(user.url) ?? "https://www.pexels.com") : "https://www.pexels.com",
  };
}

/** Unconfigured-key error payload. Never includes key material. */
export function notConfiguredError() {
  return {
    status: 400 as const,
    body: {
      error: NOT_CONFIGURED_MESSAGE,
      code: "pexels_not_configured" as const,
    },
  };
}

/** Thrown by fetchPexelsMedia; status 0 = network failure, else HTTP. */
export class PexelsApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(status ? `Pexels request failed with HTTP ${status}.` : message);
    this.name = "PexelsApiError";
    this.status = status;
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Server-side call to Pexels photo or video search. `fetchImpl` is injectable
 * for tests; production passes the global fetch. Never logs the API key.
 */
export async function fetchPexelsMedia(
  apiKey: string,
  params: PexelsSearchParams,
  fetchImpl: FetchImpl = fetch,
): Promise<{ results: Array<PexelsPhoto | PexelsVideo>; total: number }> {
  const path = params.type === "video" ? "/v1/videos/search" : "/v1/search";
  const url =
    `${PEXELS_API_BASE}${path}?query=${encodeURIComponent(params.q)}` +
    `&page=${params.page}&per_page=${params.perPage}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Authorization: apiKey } });
  } catch {
    throw new PexelsApiError(0, "Could not reach Pexels.");
  }
  if (!res.ok) {
    throw new PexelsApiError(res.status, "");
  }
  const json = (await res.json()) as {
    photos?: unknown;
    videos?: unknown;
    total_results?: unknown;
  };
  const list = params.type === "video" ? json.videos : json.photos;
  const results = Array.isArray(list)
    ? list
        .map((raw: unknown): PexelsPhoto | PexelsVideo | null =>
          params.type === "video" ? mapPexelsVideo(raw) : mapPexelsPhoto(raw),
        )
        .filter((m): m is PexelsPhoto | PexelsVideo => m !== null)
    : [];
  const total = typeof json.total_results === "number" ? json.total_results : results.length;
  return { results, total };
}
