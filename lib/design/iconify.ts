// Marketr — Phase 11 "Canvas": Iconify icon integration (default, no key).
// Replaces the thin "24 original icons" with search + insert over Iconify's
// 300k+ open-source icons. Search runs client-side (CORS-open API); on pick,
// the SVG is fetched ONCE, sanitized, and stored in the element's document
// data (`iconRef` + `body` + `viewBox`). Canvas rendering and PNG/PDF/SVG
// export then never touch the network.
//
// ── LICENSE SAFETY (load-bearing, per docs/phase11/asset-api-survey.md §4) ──
// Iconify aggregates 200+ icon sets with PER-SET licensing; the API software
// being MIT does NOT cover the artwork. The picker therefore enforces a
// hard allowlist of permissive-only prefixes (MIT / Apache-2.0 / ISC / CC0).
// CC-BY sets (e.g. Font Awesome Free) are deliberately NOT in the default
// allowlist, so NO per-export attribution is required — the footer note in
// IconsPanel states this. Bundling posture: we never vendor sets into the
// repo; we fetch SVGs on demand and store the sanitized body in the user's
// own document, keeping third-party art out of Marketr's distribution.
//
// Hard-excluded: CC-BY-SA sets (entypo, arcticons — share-alike would attach
// to user exports), GPL sets (dashicons, gridicons, wordpress, et), CC-BY-NC
// sets (cbi, ps — non-commercial is incompatible with the commercial tier),
// and OpenMoji (CC BY-SA 4.0 landmine: mandatory per-export credit + any
// recolored/restyled glyph becomes a BY-SA derivative — see survey §5).
// Emoji needs are covered by Noto Emoji (Apache-2.0) via the `noto` prefix.

/**
 * Single configurable constant for the Iconify API host — the self-hosting
 * escape hatch. Point this at a self-hosted Iconify API server (MIT) or a
 * documented fallback host (api.simplesvg.com, api.unisvg.com) and every
 * call below follows.
 */
export const ICONIFY_API_BASE = "https://api.iconify.design";

/** Search page size (the API documents limit=32 as the standard page). */
export const ICONIFY_SEARCH_LIMIT = 32;
/** Hard cap on search page size to keep payloads small. */
export const ICONIFY_MAX_LIMIT = 64;
/** Cap on a stored icon body — a single vector icon has no business being larger. */
export const MAX_ICON_BODY_BYTES = 64 * 1024;

/**
 * PERMISSIVE_PREFIXES — the ONLY icon sets the picker may query.
 * Every entry is MIT / Apache-2.0 / ISC / CC0: no attribution required,
 * no share-alike, no non-commercial restriction. Do NOT add a prefix here
 * without verifying its license at iconify.design/docs/icons/collections —
 * the test suite pins this exact list and fails on any addition.
 */
export const PERMISSIVE_PREFIXES: readonly string[] = [
  "mdi", // Material Design Icons — Apache-2.0
  "material-symbols", // Material Symbols — Apache-2.0
  "lucide", // Lucide — ISC
  "tabler", // Tabler Icons — MIT
  "heroicons", // Heroicons — MIT
  "bi", // Bootstrap Icons — MIT
  "ph", // Phosphor Icons — MIT
  "fluent", // Fluent UI System Icons — MIT
  "ri", // Remix Icon — Apache-2.0
  "carbon", // Carbon Icons — Apache-2.0
  "devicon", // Devicon — MIT
  "simple-icons", // Simple Icons (brands) — CC0
  "logos", // SVG Logos — CC0
  "noto", // Noto Emoji — Apache-2.0 (emoji coverage without OpenMoji)
];

/**
 * EXCLUDED_PREFIXES — hard-banned sets. The guard rejects these even if a
 * caller passes them explicitly; tests assert every entry is rejected.
 */
export const EXCLUDED_PREFIXES: readonly string[] = [
  "entypo", // CC BY-SA 4.0 — share-alike
  "arcticons", // CC BY-SA 4.0 — share-alike
  "dashicons", // GPL — copyleft
  "gridicons", // GPL — copyleft
  "wordpress", // GPL — copyleft
  "et", // GPL — copyleft
  "cbi", // CC BY-NC — non-commercial, incompatible with commercial tier
  "ps", // CC BY-NC — non-commercial, incompatible with commercial tier
  "openmoji", // CC BY-SA 4.0 — per-export credit + derivative share-alike (survey §5)
];

/** Thrown when a caller requests an icon set outside the allowlist. */
export class IconifyPrefixError extends Error {
  readonly prefix: string;
  constructor(prefix: string) {
    super(
      `Icon set "${prefix}" is not in the permissive allowlist and cannot be used. ` +
        `Only MIT/Apache-2.0/ISC/CC0 sets are searchable by default.`,
    );
    this.name = "IconifyPrefixError";
    this.prefix = prefix;
  }
}

/** Thrown on Iconify API failures (HTTP or malformed payload). */
export class IconifyApiError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "IconifyApiError";
    this.status = status;
  }
}

/** Thrown when a fetched icon body exceeds MAX_ICON_BODY_BYTES. */
export class IconifyBodyTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`Icon SVG body is ${bytes} bytes; the cap is ${MAX_ICON_BODY_BYTES}.`);
    this.name = "IconifyBodyTooLargeError";
    this.bytes = bytes;
  }
}

/** Normalizes a user/caller-supplied prefix for the guard check. */
function normalizePrefix(prefix: string): string {
  return prefix.trim().toLowerCase();
}

/**
 * License guard: true ONLY for prefixes on the permissive allowlist.
 * Unknown, malformed, and excluded prefixes all return false.
 */
export function isPrefixAllowed(prefix: string): boolean {
  const p = normalizePrefix(prefix);
  if (!/^[a-z0-9-]+$/.test(p)) return false;
  return (PERMISSIVE_PREFIXES as readonly string[]).includes(p);
}

/** Throws IconifyPrefixError unless the prefix is allowlisted. */
export function assertPrefixAllowed(prefix: string): void {
  if (!isPrefixAllowed(prefix)) throw new IconifyPrefixError(prefix);
}

/** One search hit: an Iconify icon reference "prefix:name". */
export interface IconSearchResult {
  prefix: string;
  name: string;
  /** Canonical "prefix:name" reference, stored in the element's document data. */
  ref: string;
}

function toSearchResult(ref: string): IconSearchResult {
  const i = ref.indexOf(":");
  const prefix = i >= 0 ? ref.slice(0, i) : "";
  const name = i >= 0 ? ref.slice(i + 1) : ref;
  return { prefix, name, ref };
}

/** A sanitized icon, ready to insert into a document. */
export interface IconSvg extends IconSearchResult {
  /** Sanitized inner-SVG body (no scripts, handlers, styles, animations). */
  body: string;
  /** viewBox from the source SVG, e.g. "0 0 24 24". */
  viewBox: string;
}

/**
 * Builds the search URL (exported for tests; searchIcons uses it).
 * Every requested prefix is validated against the allowlist first.
 */
export function buildSearchUrl(
  query: string,
  prefixes?: string[],
  limit: number = ICONIFY_SEARCH_LIMIT,
): string {
  const q = query.trim();
  if (q.length === 0) throw new IconifyApiError("Search query must not be empty.", 400);
  const use = prefixes && prefixes.length > 0 ? prefixes : [...PERMISSIVE_PREFIXES];
  for (const p of use) assertPrefixAllowed(p);
  const params = new URLSearchParams({
    query: q,
    limit: String(Math.max(1, Math.min(limit, ICONIFY_MAX_LIMIT))),
    prefixes: use.join(","),
  });
  return `${ICONIFY_API_BASE}/search?${params.toString()}`;
}

/**
 * Keyless Iconify search. The `prefixes` param passed to the API contains
 * ONLY allowlisted prefixes, so a compromised/compromising set can never be
 * reached through this client.
 */
export async function searchIcons(
  query: string,
  opts: { prefixes?: string[]; limit?: number } = {},
): Promise<{ results: IconSearchResult[]; total: number }> {
  const url = buildSearchUrl(query, opts.prefixes, opts.limit);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new IconifyApiError(
      `Icon search is unreachable (${e instanceof Error ? e.message : "network error"}). Check your connection and try again.`,
    );
  }
  if (!res.ok) throw new IconifyApiError(`Icon search failed (HTTP ${res.status}).`, res.status);
  const json = (await res.json()) as { icons?: unknown; total?: unknown };
  const icons = Array.isArray(json.icons) ? json.icons : [];
  const results = icons
    .filter((r): r is string => typeof r === "string" && r.includes(":"))
    .map(toSearchResult)
    // Defense in depth: the API should only return what we asked for, but
    // never let a non-allowlisted prefix slip into the picker.
    .filter((r) => isPrefixAllowed(r.prefix));
  const total = typeof json.total === "number" && Number.isFinite(json.total) ? json.total : results.length;
  return { results, total };
}

/** Extracts the inner body and viewBox from a full `<svg>…</svg>` document. */
export function parseIconSvg(svgText: string): { body: string; viewBox: string } {
  const vb = svgText.match(/<svg\b[^>]*\bviewBox\s*=\s*("([^"]*)"|'([^']*)')/i);
  const viewBox = (vb?.[2] ?? vb?.[3] ?? "").trim();
  if (!viewBox) throw new IconifyApiError("Icon SVG has no viewBox; refusing to store it.", 502);
  const body = svgText
    .replace(/^[\s\S]*?<svg\b[^>]*>/i, "")
    .replace(/<\/svg\s*>[\s\S]*$/i, "")
    .trim();
  if (!body) throw new IconifyApiError("Icon SVG has an empty body; refusing to store it.", 502);
  return { body, viewBox };
}

/** Rejects oversized icon bodies before they enter the document. */
export function assertBodySize(body: string): void {
  const bytes = body.length; // SVG bodies are ASCII-dominant; length ≈ bytes
  if (bytes > MAX_ICON_BODY_BYTES) throw new IconifyBodyTooLargeError(bytes);
}

/**
 * Sanitizes an SVG inner body for storage in a design document. Strips:
 * - HTML/XML comments
 * - <script> and <style> elements (and any CSS they carry)
 * - SMIL animation elements (<animate*>, <set>) — stored icons are static
 * - <foreignObject> (can host arbitrary HTML)
 * - event-handler attributes (onclick, onload, …)
 * - inline style="" attributes (keeps the document's fill authoritative)
 * - javascript:/data:text/html hrefs (internal #fragment refs are kept)
 */
export function sanitizeSvgBody(dirty: string): string {
  let out = dirty;
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");
  out = out.replace(/<(animate|animateTransform|animateMotion|set)\b[\s\S]*?<\/(animate|animateTransform|animateMotion|set)\s*>/gi, "");
  out = out.replace(/<(animate|animateTransform|animateMotion|set)\b[^>]*\/>/gi, "");
  out = out.replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "");
  out = out.replace(/\son[a-zA-Z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(
    /\s(xlink:href|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (m, _attr, _q, v1: string, v2: string, v3: string) => {
      const v = (v1 ?? v2 ?? v3 ?? "").trim().toLowerCase();
      if (v.startsWith("javascript:") || v.startsWith("data:text/html")) return "";
      return m;
    },
  );
  return out.trim();
}

/**
 * Fetches ONE icon as a standalone SVG, sanitizes it, and returns the
 * storable form. Used on pick (or re-pick); the panel's grid uses the
 * batch variant below so thumbnails don't each cost a request.
 */
export async function fetchIconSvg(prefix: string, name: string): Promise<IconSvg> {
  assertPrefixAllowed(prefix);
  const p = normalizePrefix(prefix);
  const n = name.trim();
  if (!/^[a-z0-9-]+$/i.test(n) || n.length === 0)
    throw new IconifyApiError(`Invalid icon name "${name}".`, 400);
  const url = `${ICONIFY_API_BASE}/${p}/${encodeURIComponent(n)}.svg`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new IconifyApiError(
      `Could not fetch icon ${p}:${n} (${e instanceof Error ? e.message : "network error"}).`,
    );
  }
  if (!res.ok) throw new IconifyApiError(`Icon ${p}:${n} not found (HTTP ${res.status}).`, res.status);
  const text = await res.text();
  assertBodySize(text);
  const { body, viewBox } = parseIconSvg(text);
  const clean = sanitizeSvgBody(body);
  assertBodySize(clean);
  return { prefix: p, name: n, ref: `${p}:${n}`, body: clean, viewBox };
}

/**
 * Batch-fetches several icons of ONE prefix in a single request
 * (GET /{prefix}.json?icons=a,b,c). The panel groups search hits by prefix
 * and calls this once per prefix for the results grid.
 */
export async function fetchIconBatch(prefix: string, names: string[]): Promise<IconSvg[]> {
  assertPrefixAllowed(prefix);
  const p = normalizePrefix(prefix);
  const clean = [...new Set(names.map((n) => n.trim()).filter((n) => /^[a-z0-9-]+$/i.test(n)))];
  if (clean.length === 0) return [];
  const url = `${ICONIFY_API_BASE}/${p}.json?icons=${clean.map(encodeURIComponent).join(",")}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new IconifyApiError(
      `Could not fetch icons from ${p} (${e instanceof Error ? e.message : "network error"}).`,
    );
  }
  if (!res.ok) throw new IconifyApiError(`Icon batch for ${p} failed (HTTP ${res.status}).`, res.status);
  const json = (await res.json()) as {
    prefix?: unknown;
    width?: unknown;
    height?: unknown;
    icons?: Record<string, { body?: unknown }>;
  };
  const w = typeof json.width === "number" ? json.width : 24;
  const h = typeof json.height === "number" ? json.height : 24;
  const viewBox = `0 0 ${w} ${h}`;
  const found = json.icons && typeof json.icons === "object" ? json.icons : {};
  const out: IconSvg[] = [];
  for (const n of clean) {
    const raw = found[n]?.body;
    if (typeof raw !== "string" || raw.length === 0) continue;
    assertBodySize(raw);
    const body = sanitizeSvgBody(raw);
    if (body.length === 0) continue;
    assertBodySize(body);
    out.push({ prefix: p, name: n, ref: `${p}:${n}`, body, viewBox });
  }
  return out;
}

/** Parses a viewBox like "0 0 24 24" into its width/height (falls back to 24×24). */
export function parseViewBoxSize(viewBox: string): { w: number; h: number } {
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  const w = parts[2];
  const h = parts[3];
  return {
    w: Number.isFinite(w) && w > 0 ? w : 24,
    h: Number.isFinite(h) && h > 0 ? h : 24,
  };
}

/**
 * Builds a self-contained data-URL SVG for rendering a stored icon. The
 * `color` presentation attribute tints `currentColor` artwork (most
 * outline sets: lucide, tabler, heroicons, phosphor, …) with the element's
 * fill, while fixed-fill artwork (brand logos) keeps its own colors.
 * Everything is inline — no network at render or export time.
 */
export function iconDataUrl(body: string, viewBox: string, fill: string): string {
  const vb = viewBox.trim().length > 0 ? viewBox.trim() : "0 0 24 24";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" color="${fill}">` +
    body +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
