// Marketr — Phase 12 "embeds": GrowthBook flags + experiments
// (open core; MIT bulk). BYO sidecar pattern on the host:
//   GROWTHBOOK_API_HOST  — self-hosted GrowthBook, e.g. http://growthbook:3003
//   GROWTHBOOK_API_KEY   — Admin REST API key (server only)
//   GROWTHBOOK_CLIENT_KEY — client SDK key (public, sent to the browser)
// No config → honest empty states and SDK defaults, never fake flags.
//
// REST API (v1, verified pattern): GET /api/v1/features lists feature
// definitions; PUT /api/v1/features/:key updates. Auth: `Authorization:
// Bearer <api-key>`. Feature value types: boolean | string | number | json.

export const GROWTHBOOK_API_HOST_ENV = "GROWTHBOOK_API_HOST";
export const GROWTHBOOK_API_KEY_ENV = "GROWTHBOOK_API_KEY";
export const GROWTHBOOK_CLIENT_KEY_ENV = "GROWTHBOOK_CLIENT_KEY";

export interface GrowthBookStatus {
  /** Server-side management API usable (host + API key). */
  managementConfigured: boolean;
  /** Browser SDK usable (host + client key). */
  sdkConfigured: boolean;
  name: string;
}

export function growthBookStatus(
  env: Record<string, string | undefined> = process.env,
): GrowthBookStatus {
  const host = env[GROWTHBOOK_API_HOST_ENV];
  const managementConfigured = !!(host && env[GROWTHBOOK_API_KEY_ENV]);
  const sdkConfigured = !!(host && env[GROWTHBOOK_CLIENT_KEY_ENV]);
  return { managementConfigured, sdkConfigured, name: "growthbook" };
}

/** Public SDK config — safe to serialize to the client. */
export function growthBookSdkConfig(
  env: Record<string, string | undefined> = process.env,
): { apiHost: string; clientKey: string } | null {
  const status = growthBookStatus(env);
  if (!status.sdkConfigured) return null;
  return {
    apiHost: env[GROWTHBOOK_API_HOST_ENV]!.replace(/\/+$/, ""),
    clientKey: env[GROWTHBOOK_CLIENT_KEY_ENV]!,
  };
}

export class GrowthBookApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GrowthBookApiError";
  }
}

type FetchImpl = typeof fetch;

function gbBase(env: Record<string, string | undefined>): string {
  const host = env[GROWTHBOOK_API_HOST_ENV];
  if (!host) throw new GrowthBookApiError(0, "GrowthBook is not configured (GROWTHBOOK_API_HOST).");
  return host.replace(/\/+$/, "");
}

function gbKey(env: Record<string, string | undefined>): string {
  const key = env[GROWTHBOOK_API_KEY_ENV];
  if (!key) throw new GrowthBookApiError(0, "GrowthBook is not configured (GROWTHBOOK_API_KEY).");
  return key;
}

export type GrowthBookValueType = "boolean" | "string" | "number" | "json";

export interface GrowthBookFeature {
  id: string;
  valueType: GrowthBookValueType;
  defaultValue: unknown;
  description: string;
  /** Number of force/condition rules attached. */
  rulesCount: number;
}

function normalizeValueType(raw: unknown): GrowthBookValueType {
  return raw === "boolean" || raw === "string" || raw === "number" || raw === "json"
    ? raw
    : "json";
}

/** Normalize one feature row from GET /api/v1/features. */
export function normalizeFeature(raw: unknown): GrowthBookFeature | null {
  const f = raw as Record<string, unknown> | null;
  if (!f || typeof f["id"] !== "string") return null;
  const rules = f["rules"];
  return {
    id: f["id"] as string,
    valueType: normalizeValueType(f["valueType"]),
    defaultValue: f["defaultValue"] ?? null,
    description: typeof f["description"] === "string" ? f["description"] : "",
    rulesCount: Array.isArray(rules) ? rules.length : 0,
  };
}

async function gbFetch(
  path: string,
  init: RequestInit,
  fetchImpl: FetchImpl,
  env: Record<string, string | undefined>,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${gbBase(env)}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gbKey(env)}`,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new GrowthBookApiError(0, "Could not reach the GrowthBook sidecar.");
  }
  const json = (await res.json().catch(() => null)) as {
    message?: string;
  } | null;
  if (!res.ok) {
    throw new GrowthBookApiError(
      res.status,
      json?.message ?? `GrowthBook request failed with HTTP ${res.status}.`,
    );
  }
  return json;
}

/** GET /api/v1/features — list all feature definitions. */
export async function listGrowthBookFeatures(
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<GrowthBookFeature[]> {
  const json = (await gbFetch("/api/v1/features", { method: "GET" }, fetchImpl, env)) as {
    features?: unknown[];
  };
  const rows = Array.isArray(json.features) ? json.features : [];
  return rows
    .map(normalizeFeature)
    .filter((f): f is GrowthBookFeature => f !== null);
}

/**
 * PUT /api/v1/features/:key — set the default value (the "toggle").
 * Boolean flags toggle true/false; other types take the raw value.
 */
export async function setGrowthBookDefault(
  key: string,
  defaultValue: unknown,
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  await gbFetch(
    `/api/v1/features/${encodeURIComponent(key)}`,
    { method: "PUT", body: JSON.stringify({ defaultValue }) },
    fetchImpl,
    env,
  );
}

// ---------------------------------------------------------------------------
// Marketr's own flags (wired into real UI). These defaults are the contract
// when GrowthBook is unconfigured — the SDK falls back to them, so the app
// behaves identically with or without the sidecar.
// ---------------------------------------------------------------------------

export const MARKETR_FLAGS = {
  /** Studio designs index: compact hero treatment vs the default roomy one. */
  "studio.compact-hero": { key: "studio.compact-hero", defaultValue: false },
  /** Content engine: v2 brief prompt treatment on the brief generator. */
  "content.brief-v2": { key: "content.brief-v2", defaultValue: false },
} as const;

export type MarketrFlagKey = keyof typeof MARKETR_FLAGS;

/** Plain-object snapshot of flag defaults — what the client SDK seeds with. */
export function marketrFlagDefaults(): Record<MarketrFlagKey, boolean> {
  return {
    "studio.compact-hero": MARKETR_FLAGS["studio.compact-hero"].defaultValue,
    "content.brief-v2": MARKETR_FLAGS["content.brief-v2"].defaultValue,
  };
}

// ---------------------------------------------------------------------------
// Tenant-scoped overrides (the actual "toggle for the tenant").
// ---------------------------------------------------------------------------
// GrowthBook holds the flag *definitions*; the admin toggle writes a
// per-workspace override row (see ./growthbook-overrides, server-only)
// instead of mutating GrowthBook's global default. Effective value =
// override ?? GrowthBook default ?? built-in default. One tenant's
// experiment never leaks into another's.
//
// NOTE: this module must stay server-import-safe for the browser bundle —
// GrowthBookProvider ("use client") imports MARKETR_FLAGS from here. The
// prisma-backed read/write helpers live in ./growthbook-overrides and are
// only imported by API routes.

export type EffectiveFeature = GrowthBookFeature & {
  /** The value this workspace actually evaluates. */
  effectiveValue: unknown;
  /** True when a workspace override (not the GrowthBook default) wins. */
  overridden: boolean;
};

/**
 * Merge workspace overrides onto remote features, and include any local
 * overrides for flags GrowthBook doesn't define (e.g. a flag deleted
 * upstream but still toggled for this tenant).
 */
export function applyFlagOverrides(
  features: GrowthBookFeature[],
  overrides: Record<string, unknown>,
): EffectiveFeature[] {
  const seen = new Set<string>();
  const out: EffectiveFeature[] = features.map((f) => {
    seen.add(f.id);
    const has = Object.prototype.hasOwnProperty.call(overrides, f.id);
    return {
      ...f,
      effectiveValue: has ? overrides[f.id] : f.defaultValue,
      overridden: has,
    };
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (seen.has(key)) continue;
    out.push({
      id: key,
      valueType: typeof value === "boolean" ? "boolean" : "json",
      defaultValue: null,
      description: "Workspace override for a flag not defined in GrowthBook.",
      rulesCount: 0,
      effectiveValue: value,
      overridden: true,
    });
  }
  return out;
}
