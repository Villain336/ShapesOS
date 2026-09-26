// Marketr — Phase 10 M6: SERP vendor routing.
// Default: TalorData when needAiOverview, Serper at volume, DataForSEO
// fallback — ALL swappable via serp_vendor_config routing rules.
// The M7 kill-switch test flips the default vendor and expects every
// consumer to keep working: routing reads config at call time, never cached.

import {
  buildSerpAdapters,
  ensureVendorConfigs,
  getVendorConfigs,
  type RoutingRules,
} from "./credentials";
import { assertBudgetAvailable, recordApiMeter } from "./meter";
import { auditApiCall } from "./audit";
import type { SerpProvider, SerpResponse, SerpSearchOpts, SerpVendorId } from "./types";
import { VendorNotConfigured } from "./types";

export const ALL_VENDORS: SerpVendorId[] = ["serper", "dataforseo", "talordata"];

export const DEFAULT_ROUTING: Required<RoutingRules> = {
  default: "serper",
  aiOverview: "talordata",
  fallback: ["dataforseo", "serper", "talordata"],
};

/**
 * Pure vendor selection — tested without DB or network.
 * Returns the chosen vendor id, or null when none is configured.
 */
export function resolveVendor(
  rules: RoutingRules,
  opts: SerpSearchOpts,
  configuredVendors: SerpVendorId[],
): SerpVendorId | null {
  const configured = new Set(configuredVendors);
  const preferred =
    opts.needAiOverview === true ? (rules.aiOverview ?? DEFAULT_ROUTING.aiOverview) : (rules.default ?? DEFAULT_ROUTING.default);
  const chain: SerpVendorId[] = [preferred, ...(rules.fallback ?? DEFAULT_ROUTING.fallback)];
  for (const v of chain) {
    if (configured.has(v)) return v;
  }
  return null;
}

export interface FetchSerpDeps {
  /** Overrides for tests (kill-switch) — defaults hit the live registry. */
  adapters?: Record<SerpVendorId, SerpProvider>;
  routingRules?: RoutingRules;
  budgetCheck?: (estimatedCostUsd: number) => Promise<void>;
  meter?: (vendor: SerpVendorId, result: SerpResponse) => Promise<void>;
  audit?: (summary: string) => Promise<void>;
}

/**
 * Fetch one SERP through the abstracted vendor layer.
 * Steps: circuit breaker → resolve vendor → adapter.search → meter → audit.
 * Throws VendorNotConfigured when NO vendor is configured (typed, never crash).
 */
export async function fetchSerp(
  workspaceId: string,
  keyword: string,
  locale: string,
  opts: SerpSearchOpts = {},
  deps: FetchSerpDeps = {},
): Promise<SerpResponse> {
  const adapters = deps.adapters ?? (await buildSerpAdapters(workspaceId));
  const configured = ALL_VENDORS.filter((v) => adapters[v].isConfigured());

  // Circuit breaker FIRST: never burn margin on an unbudgeted call.
  const cheapest = configured.reduce(
    (min, v) => Math.min(min, adapters[v].costPerSerpCallUsd()),
    configured.length > 0 ? Infinity : 0,
  );
  const budgetCheck = deps.budgetCheck ?? ((est: number) => assertBudgetAvailable(workspaceId, est));
  await budgetCheck(configured.length > 0 ? cheapest : 0);

  let rules = deps.routingRules;
  if (!rules) {
    await ensureVendorConfigs(workspaceId);
    const configs = await getVendorConfigs(workspaceId);
    const merged: RoutingRules = {};
    for (const c of configs) Object.assign(merged, c.routingRules);
    rules = merged;
  }

  const chosen = resolveVendor(rules, opts, configured);
  if (!chosen) {
    throw new VendorNotConfigured("serper");
  }
  const adapter = adapters[chosen];
  const result = await adapter.search(keyword, locale, opts);

  const meterFn = deps.meter ?? ((v, r) => recordApiMeter(workspaceId, v, "serp_call", 1, r.costUsd));
  const auditFn =
    deps.audit ?? ((s) => auditApiCall(workspaceId, "serpVendorCalled", s));
  await meterFn(chosen, result);
  await auditFn(
    `SERP "${keyword}" (${locale}) via ${chosen}: ${result.results.length} results, AIO=${result.aiOverviewPresent}, $${result.costUsd.toFixed(6)}`,
  );
  return result;
}

/** Health snapshot for the data-costs UI: which vendors are configured. */
export async function vendorHealth(workspaceId: string): Promise<Array<{ vendor: SerpVendorId; configured: boolean; costPerSerpCallUsd: number }>> {
  const adapters = await buildSerpAdapters(workspaceId);
  return ALL_VENDORS.map((v) => ({
    vendor: v,
    configured: adapters[v].isConfigured(),
    costPerSerpCallUsd: adapters[v].costPerSerpCallUsd(),
  }));
}
