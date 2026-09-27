// Marketr — Phase 11 "Canvas": Poly Haven 3D asset integration.
//
// Two halves:
//   1. Poly Haven live search (keyless API at https://api.polyhaven.com).
//      Server-side only: the ToS-mandated identifying Referer/user-agent is
//      sent from the server routes, never the browser. All Poly Haven
//      assets are CC0 catalog-wide, so no attribution is legally required —
//      but the ToS asks for a "Powered by Poly Haven" credit line near
//      surfaced content, which the 3D panel renders.
//   2. CURATED_3D_ASSETS — the pre-rendered sticker bundle (transparent
//      PNGs at 3 preset angles, rendered once by
//      scripts/render-3d-stills.mts from Kenney CC0 GLBs). The panel is a
//      gallery inserting those PNGs as normal Konva image nodes; no 3D
//      viewport ships in v1.

export const POLY_HAVEN_API_BASE = "https://api.polyhaven.com";
export const POLY_HAVEN_URL = "https://polyhaven.com";
/** Per Poly Haven ToS: identify the app on every API call. Server-side only. */
export const POLY_HAVEN_REFERER = "https://marketr.studio";
export const POLY_HAVEN_USER_AGENT = "Marketr-Studio/1.0 (+https://marketr.studio)";
/** Required credit line (rendered in the 3D panel, not per-asset). */
export const POLY_HAVEN_CREDIT = "Powered by Poly Haven";

/** A trimmed Poly Haven asset from the /search + /info endpoints. */
export interface PolyHavenAsset {
  /** Slug, e.g. "WoodenChair_01". */
  id: string;
  name: string;
  categories: string[];
  /** 256px CDN render thumbnail (hotlinkable). Has a baked background. */
  thumbnailUrl: string;
  /** polyhaven.com asset page for the credit link. */
  pageUrl: string;
  license: "CC0";
}

/** Camera angles the stills are pre-rendered at. */
export const THREE_D_ANGLES = ["three-quarter", "front", "side"] as const;
export type ThreeDAngle = (typeof THREE_D_ANGLES)[number];

/** One entry of the curated sticker bundle. */
export interface CuratedModel3D {
  /** Stable id, matches render-3d-stills.mts job ids. */
  id: string;
  name: string;
  category: string;
  /** Transparent PNG per angle, relative to the site root. */
  png: Record<ThreeDAngle, string>;
  /** Always a CC0 source; "poly-haven" for live-search inserts. */
  source: "kenney" | "poly-haven";
  license: "CC0";
}

const still = (id: string, angle: ThreeDAngle) => `/studio/3d-stills/${id}-${angle}.png`;

function curated(id: string, name: string, category: string): CuratedModel3D {
  return {
    id,
    name,
    category,
    png: {
      "three-quarter": still(id, "three-quarter"),
      front: still(id, "front"),
      side: still(id, "side"),
    },
    source: "kenney",
    license: "CC0",
  };
}

/**
 * The curated starter bundle. All models are Kenney (CC0, no attribution
 * required), pre-rendered to transparent PNGs by
 * scripts/render-3d-stills.mts. Kept small on purpose — repo bloat is the
 * failure mode here.
 *
 * Quaternius is deliberately NOT in the bundle: their packs are
 * distributed via itch.io with bot protection that blocked the curation
 * environment (curl + headless chromium), and there is no official
 * direct-URL pattern or keyless API. Per the "when in doubt, exclude"
 * rule, they were left out; the manifest can grow later when a clean
 * fetch path exists.
 */
export const CURATED_3D_ASSETS: CuratedModel3D[] = [
  curated("kenney-chair", "Dining Chair", "Furniture"),
  curated("kenney-sofa", "Sofa", "Furniture"),
  curated("kenney-coffee-table", "Coffee Table", "Furniture"),
  curated("kenney-floor-lamp", "Floor Lamp", "Furniture"),
  curated("kenney-potted-plant", "Potted Plant", "Furniture"),
  curated("kenney-laptop", "Laptop", "Tech"),
  curated("kenney-tree", "Tree", "Nature"),
  curated("kenney-bush", "Bush", "Nature"),
  curated("kenney-rock", "Rock", "Nature"),
  curated("kenney-sedan", "Sedan", "Vehicles"),
  curated("kenney-truck", "Truck", "Vehicles"),
  curated("kenney-astronaut", "Astronaut", "Space"),
  curated("kenney-space-racer", "Space Racer", "Space"),
];

export interface PolyHavenSearchParams {
  q: string;
  limit: number;
}

export const MAX_SEARCH_LIMIT = 24;
export const DEFAULT_SEARCH_LIMIT = 12;

/** 400-class param failure; the route maps it straight to a JSON response. */
export class SearchParamError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "SearchParamError";
  }
}

/** Validate/normalize ?q=&limit=. Throws SearchParamError (400). */
export function parsePolyHavenSearchParams(sp: URLSearchParams): PolyHavenSearchParams {
  const q = (sp.get("q") ?? "").trim().toLowerCase();
  if (!q) throw new SearchParamError("Search query (q) is required.");
  if (q.length > 100) {
    throw new SearchParamError("Search query is too long (max 100 characters).");
  }
  const rawLimit = sp.get("limit");
  let limit = DEFAULT_SEARCH_LIMIT;
  if (rawLimit !== null && rawLimit.trim() !== "") {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1) {
      throw new SearchParamError("limit must be a positive integer.");
    }
    limit = n;
  }
  return { q, limit: Math.min(limit, MAX_SEARCH_LIMIT) };
}

/** Thrown by the Poly Haven fetchers; status 0 = network failure, else HTTP. */
export class PolyHavenApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PolyHavenApiError";
    this.status = status;
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** Server-side headers identifying Marketr per the Poly Haven ToS. */
export function polyHavenHeaders(): Record<string, string> {
  return {
    Referer: POLY_HAVEN_REFERER,
    "User-Agent": POLY_HAVEN_USER_AGENT,
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Trim one /info/{id} payload to the documented shape. Returns null when
 * the payload lacks anything needed to render the result. Type 2 = model;
 * HDRIs/textures (types 0/1) are excluded from the 3D panel.
 */
export function mapPolyHavenInfo(slug: string, raw: unknown): PolyHavenAsset | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== 2) return null;
  const name = str(r.name)?.trim();
  const thumbnailUrl = str(r.thumbnail_url);
  if (!name || !thumbnailUrl) return null;
  const categories = Array.isArray(r.categories)
    ? r.categories.filter((c): c is string => typeof c === "string")
    : [];
  return {
    id: slug,
    name,
    categories,
    thumbnailUrl,
    pageUrl: `${POLY_HAVEN_URL}/a/${slug}`,
    license: "CC0",
  };
}

/**
 * Server-side Poly Haven search: /search (slugs) + /info per slug.
 * `fetchImpl` is injectable for tests; production passes the global fetch.
 * Info lookups run sequentially — the API has unpublished rate limits and
 * returns 429 with Retry-After when pushed.
 */
export async function fetchPolyHavenModels(
  params: PolyHavenSearchParams,
  fetchImpl: FetchImpl = fetch,
): Promise<{ results: PolyHavenAsset[]; total: number }> {
  const headers = polyHavenHeaders();
  let searchRes: Response;
  try {
    searchRes = await fetchImpl(
      `${POLY_HAVEN_API_BASE}/search?q=${encodeURIComponent(params.q)}&t=models&limit=${params.limit}`,
      { headers },
    );
  } catch {
    throw new PolyHavenApiError(0, "Could not reach Poly Haven.");
  }
  if (!searchRes.ok) {
    throw new PolyHavenApiError(searchRes.status, `Poly Haven search failed with HTTP ${searchRes.status}.`);
  }
  const searchJson = (await searchRes.json()) as { results?: unknown; total?: unknown };
  const slugs = Array.isArray(searchJson.results)
    ? searchJson.results
        .map((r) => (typeof r === "object" && r !== null ? str((r as Record<string, unknown>).slug) : null))
        .filter((s): s is string => s !== null)
    : [];
  const total = typeof searchJson.total === "number" ? searchJson.total : slugs.length;

  const results: PolyHavenAsset[] = [];
  for (const slug of slugs.slice(0, params.limit)) {
    try {
      const infoRes = await fetchImpl(`${POLY_HAVEN_API_BASE}/info/${encodeURIComponent(slug)}`, { headers });
      if (!infoRes.ok) continue;
      const asset = mapPolyHavenInfo(slug, await infoRes.json());
      if (asset) results.push(asset);
    } catch {
      // One bad info lookup must not kill the whole search.
    }
  }
  return { results, total };
}

/**
 * Provenance carried on every inserted 3D element's `custom` bag, so
 * exports and credit screens stay traceable.
 */
export function threeDProvenance(
  source: CuratedModel3D["source"],
  assetId: string,
  extra?: Record<string, string>,
): { source: string; assetId: string; license: "CC0" } & Record<string, string> {
  return { source, assetId, license: "CC0", ...(extra ?? {}) };
}

/** Integrity check for the curated manifest (used by tests + CI). */
export function validateCuratedManifest(
  assets: CuratedModel3D[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const a of assets) {
    if (!a.id || seen.has(a.id)) problems.push(`duplicate or empty id: ${a.id || "(empty)"}`);
    seen.add(a.id);
    if (!a.name) problems.push(`missing name for ${a.id}`);
    if (a.license !== "CC0") problems.push(`${a.id}: license is not CC0`);
    if (a.source !== "kenney" && a.source !== "poly-haven") {
      problems.push(`${a.id}: unknown source ${a.source}`);
    }
    for (const angle of THREE_D_ANGLES) {
      const p = a.png[angle];
      if (!p || !p.startsWith("/studio/3d-stills/") || !p.endsWith(`-${angle}.png`)) {
        problems.push(`${a.id}: bad png path for angle ${angle}: ${p}`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
