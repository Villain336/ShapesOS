// Marketr — Phase 11 "Canvas": Brandfetch brand-lookup integration.
// BYO-key pattern (same as the Unsplash key): BRANDFETCH_API_KEY lives on the
// host environment, is read server-side only, and is never exposed to the
// browser. No key → loud honest error, never fake brand data.
//
// Brandfetch API v2: GET https://api.brandfetch.io/v2/brands/{domain}
// with `Authorization: Bearer <key>`. Domain input is validated/sanitized
// before the request; the raw API payload is trimmed to a client-safe shape
// (no key material, no vendor internals).
//
// The caller is responsible for the trademark/fair-use warning: third-party
// logos carry trademark restrictions — only import brands you have the right
// to use.

export const BRANDFETCH_API_BASE = "https://api.brandfetch.io/v2";
/** Upper bound for a pasted domain/URL (RFC 1035 max is 253). */
export const MAX_DOMAIN_LENGTH = 253;
/** Brandfetch lookups time out rather than hanging the panel. */
export const LOOKUP_TIMEOUT_MS = 15_000;

/** Honest unconfigured-key message. Names the env var; never its value. */
export const NOT_CONFIGURED_MESSAGE =
  "Brand lookup needs a Brandfetch API key. Add BRANDFETCH_API_KEY in Settings → Providers, then try again.";

/** Server-side only: the API key never leaves the server. */
export function getBrandfetchApiKey(): string {
  return (process.env.BRANDFETCH_API_KEY ?? "").trim();
}

/** Status shape mirrors lib/providers providerStatus() for the Settings UI. */
export function brandfetchStatus() {
  const configured = getBrandfetchApiKey().length > 0;
  return { name: "brandfetch", isLive: configured, configured };
}

/** Client-safe trimmed brand. Contains no key material by construction. */
export interface BrandLookupResult {
  /** Brand display name from Brandfetch. */
  name: string;
  /** Normalized domain that was looked up. */
  domain: string;
  /** Brand description, when Brandfetch has one. */
  description: string | null;
  /** Best logo image URL (https). Null when Brandfetch has no usable logo. */
  logoUrl: string | null;
  /** Deduped #RRGGBB hex colors, in Brandfetch order. */
  colors: string[];
  /** Deduped font family names, in Brandfetch order. */
  fonts: string[];
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** 400-class domain input failure; the route maps it straight to a JSON response. */
export class DomainInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "DomainInputError";
  }
}

/** Thrown when BRANDFETCH_API_KEY is missing. Honest, never includes the key. */
export class BrandfetchNotConfiguredError extends Error {
  readonly status = 400;
  readonly code = "brandfetch_not_configured";
  constructor() {
    super(NOT_CONFIGURED_MESSAGE);
    this.name = "BrandfetchNotConfiguredError";
  }
}

/** Thrown when Brandfetch has no brand for the domain (HTTP 404). */
export class BrandfetchNotFoundError extends Error {
  readonly status = 404;
  readonly code = "brandfetch_not_found";
  constructor(domain: string) {
    super(`Brandfetch has no brand data for "${domain}". Check the spelling or try the company's main domain.`);
    this.name = "BrandfetchNotFoundError";
  }
}

/**
 * Thrown by fetchBrandfetchBrand for transport/upstream failures.
 * status 0 = network failure or timeout, else the upstream HTTP status.
 */
export class BrandfetchApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BrandfetchApiError";
    this.status = status;
  }
}

// ── Domain validation ────────────────────────────────────────────────────────

const DOMAIN_LABEL = "(?!-)[a-z0-9-]{1,63}(?<!-)";
const DOMAIN_RE = new RegExp(`^${DOMAIN_LABEL}(\\.${DOMAIN_LABEL})*$`);

/**
 * Validate and sanitize a pasted domain or URL into a bare lowercase domain.
 * Accepts "stripe.com", "https://stripe.com/pricing", "WWW.Stripe.com ".
 * Throws DomainInputError (400) for empty input, garbage, IPs, or anything
 * that is not a plausible public domain name. Never returns a URL, port,
 * path, or query string.
 */
export function normalizeDomain(raw: string): string {
  const input = (raw ?? "").trim();
  if (!input) throw new DomainInputError("Enter a domain, e.g. stripe.com.");
  if (input.length > MAX_DOMAIN_LENGTH + 32) {
    throw new DomainInputError("That domain is too long.");
  }

  let host = input;
  const schemeIdx = host.indexOf("://");
  if (schemeIdx >= 0) {
    const scheme = host.slice(0, schemeIdx).toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      throw new DomainInputError("Only http(s) URLs are accepted.");
    }
    host = host.slice(schemeIdx + 3);
  }
  // Drop path, query, fragment, and any userinfo.
  host = host.split("/")[0].split("?")[0].split("#")[0];
  const atIdx = host.lastIndexOf("@");
  if (atIdx >= 0) host = host.slice(atIdx + 1);
  // Drop port.
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx >= 0) host = host.slice(0, colonIdx);
  host = host.toLowerCase().replace(/\.$/, "");
  // Canonicalize www.<domain> → <domain>; Brandfetch treats them as the same brand.
  host = host.replace(/^www\./, "");

  if (!host) throw new DomainInputError("Enter a domain, e.g. stripe.com.");
  if (host.length > MAX_DOMAIN_LENGTH) throw new DomainInputError("That domain is too long.");
  if (!DOMAIN_RE.test(host)) {
    throw new DomainInputError(`"${input.slice(0, 80)}" is not a valid domain.`);
  }
  const labels = host.split(".");
  if (labels.length < 2) {
    throw new DomainInputError("Enter a full domain like stripe.com, not a single name.");
  }
  const tld = labels[labels.length - 1];
  if (!/[a-z]/.test(tld)) {
    // No letter in the TLD ⇒ IP address or garbage; Brandfetch needs a domain.
    throw new DomainInputError("Enter a domain name, not an IP address.");
  }
  return host;
}

// ── Response mapping ─────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isHttpUrl(v: string | null): v is string {
  return !!v && (v.startsWith("https://") || v.startsWith("http://"));
}

/** Normalize to #RRGGBB uppercase; accepts #rgb, #rrggbb with/without #. */
function normalizeHex(raw: unknown): string | null {
  const s = str(raw)?.trim();
  if (!s) return null;
  let h = s.startsWith("#") ? s.slice(1) : s;
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return `#${h.toUpperCase()}`;
}

interface LogoCandidate {
  type: string;
  formats: unknown[];
}

/**
 * Pick the best logo URL from Brandfetch's `logos` array.
 * Preference: type "logo" → "icon" → anything; first https format src wins.
 */
function pickLogoUrl(logos: unknown): string | null {
  const list = arr(logos)
    .filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null)
    .map((l) => ({ type: (str(l.type) ?? "").toLowerCase(), formats: arr(l.formats) }) as LogoCandidate);
  if (list.length === 0) return null;
  const byType = (t: string) => list.find((l) => l.type === t);
  const chosen = byType("logo") ?? byType("icon") ?? list[0];
  for (const f of chosen.formats) {
    if (typeof f === "object" && f !== null) {
      const src = str((f as Record<string, unknown>).src);
      if (isHttpUrl(src)) return src;
    }
  }
  return null;
}

function dedupe(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Trim one Brandfetch v2 brand payload to the client-safe shape.
 * Returns null for payloads missing the name/domain needed to present a brand.
 */
export function mapBrandfetchBrand(raw: unknown): BrandLookupResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name)?.trim();
  const domain = str(r.domain)?.trim()?.toLowerCase();
  if (!name || !domain) return null;

  const colors = dedupe(arr(r.colors).map((c) => {
    if (typeof c !== "object" || c === null) return null;
    return normalizeHex((c as Record<string, unknown>).hex);
  }));
  const fonts = dedupe(arr(r.fonts).map((f) => {
    if (typeof f !== "object" || f === null) return null;
    const n = str((f as Record<string, unknown>).name)?.trim();
    return n || null;
  }));

  return {
    name,
    domain,
    description: str(r.description)?.trim() || str(r.longDescription)?.trim() || null,
    logoUrl: pickLogoUrl(r.logos),
    colors,
    fonts,
  };
}

/** Brand-kit color slots in fill order when Brandfetch gives no explicit type. */
export const KIT_COLOR_SLOTS = ["primary", "secondary", "accent", "text", "muted"] as const;
/** Brand-kit font slots. */
export const KIT_FONT_SLOTS = ["heading", "body"] as const;

/**
 * Fold a lookup's colors into brand-kit `{ primary, secondary, accent, … }`
 * slots. Explicit Brandfetch type matches win; remaining distinct hexes fill
 * the remaining slots in Brandfetch order.
 */
export function brandColorsToKit(raw: unknown, colors: string[]): Record<string, string> {
  // Dedupe first so a repeated hex can't steal a type slot.
  const seen = new Set<string>();
  const unique: { hex: string; type: string | null }[] = [];
  for (const c of arr(raw)) {
    if (typeof c !== "object" || c === null) continue;
    const rec = c as Record<string, unknown>;
    const hex = normalizeHex(rec.hex);
    if (hex && !seen.has(hex)) {
      seen.add(hex);
      unique.push({ hex, type: str(rec.type)?.trim().toLowerCase() ?? null });
    }
  }
  const byType = new Map<string, string>();
  for (const { hex, type } of unique) {
    if (type && !byType.has(type)) byType.set(type, hex);
  }
  const kit: Record<string, string> = {};
  const used = new Set<string>();
  for (const slot of KIT_COLOR_SLOTS) {
    const hex = byType.get(slot);
    if (hex && !used.has(hex)) {
      kit[slot] = hex;
      used.add(hex);
    }
  }
  for (const hex of colors) {
    if (used.has(hex)) continue;
    const slot = KIT_COLOR_SLOTS.find((s) => !(s in kit));
    if (!slot) break;
    kit[slot] = hex;
    used.add(hex);
  }
  return kit;
}

/**
 * Fold a lookup's font names into brand-kit `{ heading, body }` slots.
 * Brandfetch "title" → heading, "body" → body; leftovers fill in order.
 */
export function brandFontsToKit(raw: unknown, fonts: string[]): Record<string, string> {
  // Dedupe first so a repeated name can't steal a type slot.
  const seen = new Set<string>();
  const unique: { name: string; type: string | null }[] = [];
  for (const f of arr(raw)) {
    if (typeof f !== "object" || f === null) continue;
    const rec = f as Record<string, unknown>;
    const name = str(rec.name)?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      unique.push({ name, type: str(rec.type)?.trim().toLowerCase() ?? null });
    }
  }
  const byType = new Map<string, string>();
  for (const { name, type } of unique) {
    if (type && !byType.has(type)) byType.set(type, name);
  }
  const kit: Record<string, string> = {};
  const title = byType.get("title");
  const body = byType.get("body");
  if (title) kit.heading = title;
  if (body) kit.body = body;
  for (const name of fonts) {
    if (Object.values(kit).includes(name)) continue;
    const slot = KIT_FONT_SLOTS.find((s) => !(s in kit));
    if (!slot) break;
    kit[slot] = name;
  }
  return kit;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Kit-ready view of a lookup: the trimmed brand plus colors/fonts folded
 * into brand-kit slots ({ primary, secondary, accent, … } /
 * { heading, body }). One upstream fetch feeds all three.
 */
export interface BrandKitImport {
  brand: BrandLookupResult;
  /** Colors folded into brand-kit slots. May be empty when Brandfetch has none. */
  kitColors: Record<string, string>;
  /** Fonts folded into brand-kit slots. May be empty when Brandfetch has none. */
  kitFonts: Record<string, string>;
}

/** Low-level fetch + status mapping. Returns the raw v2 payload. */
async function getRawBrand(apiKey: string, domain: string, fetchImpl: FetchImpl): Promise<unknown> {
  if (!apiKey) throw new BrandfetchNotConfiguredError();
  const url = `${BRANDFETCH_API_BASE}/brands/${encodeURIComponent(domain)}`;
  let res: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS);
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw new BrandfetchApiError(0, "Could not reach Brandfetch. Check your connection and try again.");
  }
  if (res.status === 404) throw new BrandfetchNotFoundError(domain);
  if (res.status === 401 || res.status === 403) {
    throw new BrandfetchApiError(
      res.status,
      `Brandfetch rejected the request (HTTP ${res.status}). Your API key may be invalid or revoked.`,
    );
  }
  if (res.status === 429) {
    throw new BrandfetchApiError(429, "Brandfetch rate limit reached (HTTP 429). Wait a bit and try again.");
  }
  if (!res.ok) {
    throw new BrandfetchApiError(res.status, `Brandfetch request failed with HTTP ${res.status}.`);
  }
  try {
    return await res.json();
  } catch {
    throw new BrandfetchApiError(res.status, "Brandfetch returned an unreadable response.");
  }
}

/**
 * Server-side lookup returning the trimmed brand plus kit-ready slot
 * mappings. `fetchImpl` is injectable for tests; production passes the
 * global fetch. The key travels only in the Authorization header and is
 * never logged or returned.
 *
 * Throws BrandfetchNotConfiguredError (no key), BrandfetchNotFoundError
 * (HTTP 404), or BrandfetchApiError (network/timeout/other upstream status).
 */
export async function lookupBrandForKit(
  apiKey: string,
  domain: string,
  fetchImpl: FetchImpl = fetch,
): Promise<BrandKitImport> {
  const raw = await getRawBrand(apiKey, domain, fetchImpl);
  const brand = mapBrandfetchBrand(raw);
  if (!brand) {
    throw new BrandfetchApiError(200, "Brandfetch returned an unexpected response shape.");
  }
  return {
    brand,
    kitColors: brandColorsToKit(raw, brand.colors),
    kitFonts: brandFontsToKit(raw, brand.fonts),
  };
}

/**
 * Server-side call to Brandfetch Brand API v2 — trimmed brand only.
 * Same error contract as lookupBrandForKit.
 */
export async function fetchBrandfetchBrand(
  apiKey: string,
  domain: string,
  fetchImpl: FetchImpl = fetch,
): Promise<BrandLookupResult> {
  return (await lookupBrandForKit(apiKey, domain, fetchImpl)).brand;
}
