// Marketr — Phase 10 M6: cross-user keyword-volume cache.
// The cost lever ($132/1M clickstream bulk, ~90% hit at scale [ESTIMATE]).
//
// Defensive posture (§2, §M6 — binding, enforced in tests):
//  - TTLs 30–90 days (env-tunable, default 60 / max 90)
//  - cache-invalidation-on-use: a hit refreshes expires_at (sliding window,
//    capped at max TTL from the original fetch — this is NOT a shadow DB)
//  - per-workspace attribution: every hit AND miss is metered into api_meter
//    with the caller's workspaceId (aggregate counts; keywords are never
//    exposed to another tenant)
//  - Volume is ALWAYS a band string ("1K–10K"), never false-precision points
//
// GUC quirk (migration 20260926123500_phase10_volume_cache_rls_fix):
// volume_cache has NO workspace_id column by design; RLS is enabled + forced
// with a fail-closed GUC-presence policy: nullif(current_setting(
// 'app.workspace_id',''), '') IS NOT NULL. A session with a NON-EMPTY GUC
// passes. Custom GUC placeholders decay to '' after SET LOCAL commits, so we
// ALWAYS touch volume_cache inside withWorkspaceScope(callerWorkspaceId) —
// the caller's workspace id is the system GUC value that satisfies the policy.

import { createHash } from "node:crypto";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { assertBudgetAvailable, recordApiMeter } from "./meter";
import { auditApiCall } from "./audit";
import { buildSerpAdapters } from "./credentials";
import {
  PlannerNotReady,
  VolumeUnavailableError,
  isVolumeBand,
  pointToBand,
  type VolumeBand,
} from "./types";

export const VOLUME_CACHE_TTL_DAYS = envInt("VOLUME_CACHE_TTL_DAYS", 60, 30, 90);
export const VOLUME_CACHE_MAX_TTL_DAYS = envInt("VOLUME_CACHE_MAX_TTL_DAYS", 90, 30, 90);

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.round(raw), min), max);
}

export interface VolumeLookupResult {
  band: VolumeBand;
  source: "cache" | "planner" | "vendor";
  fetchedAt: Date;
}

/** Pure: cache key = sha256(normalized keyword + locale). Tested without DB. */
export function volumeCacheKey(keyword: string, locale: string): string {
  const normalized = `${keyword.trim().toLowerCase()}|${locale.trim().toLowerCase()}`;
  return createHash("sha256").update(normalized).digest("hex");
}

/** Pure: is this cache row fresh right now? */
export function isCacheFresh(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() > now.getTime();
}

/**
 * Pure: cache-invalidation-on-use. A hit refreshes expires_at (sliding
 * window), but NEVER past maxTtlDays after the original fetch — stale rows
 * die on their own, so the cache can't become a shadow database.
 */
export function refreshExpiry(
  fetchedAt: Date,
  ttlDays: number,
  maxTtlDays: number,
  now = new Date(),
): Date {
  const sliding = now.getTime() + ttlDays * 86_400_000;
  const hardCap = fetchedAt.getTime() + maxTtlDays * 86_400_000;
  return new Date(Math.min(sliding, hardCap));
}

/** Injectable cache store — default hits Postgres; tests inject a memory store. */
export interface VolumeCacheStore {
  read(key: string, locale: string): Promise<{ volumeBand: string; fetchedAt: Date; expiresAt: Date } | null>;
  refresh(key: string, locale: string, expiresAt: Date): Promise<void>;
  write(key: string, locale: string, band: VolumeBand, source: string, ttlDays: number): Promise<void>;
}

function pgStore(workspaceId: string): VolumeCacheStore {
  return {
    read: (key, locale) =>
      withWorkspaceScope(workspaceId, (tx) =>
        tx.volumeCache.findUnique({ where: { keywordHash_locale: { keywordHash: key, locale } } }),
      ),
    refresh: (key, locale, expiresAt) =>
      withWorkspaceScope(workspaceId, (tx) =>
        tx.volumeCache.update({
          where: { keywordHash_locale: { keywordHash: key, locale } },
          data: { expiresAt, hits: { increment: 1 } },
        }),
      ).then(() => undefined),
    write: (key, locale, band, source, ttlDays) =>
      withWorkspaceScope(workspaceId, (tx) => {
        const now = new Date();
        return tx.volumeCache.upsert({
          where: { keywordHash_locale: { keywordHash: key, locale } },
          update: {
            volumeBand: band,
            source,
            fetchedAt: now,
            expiresAt: new Date(now.getTime() + ttlDays * 86_400_000),
            hits: { increment: 1 },
          },
          create: {
            keywordHash: key,
            locale,
            volumeBand: band,
            source,
            fetchedAt: now,
            expiresAt: new Date(now.getTime() + ttlDays * 86_400_000),
            hits: 0,
          },
        });
      }).then(() => undefined),
  };
}

/**
 * Keyword Planner adapter — STUB.
 * --------------------------------
 * SETUP DOCS (shown in UX copy where volume is surfaced):
 *   1. Keyword Planner is FREE via the Google Ads API (KeywordPlanIdeaService).
 *   2. It requires a Google Ads MANAGER account (not a test/express account).
 *   3. New accounts get a ~5-business-day MANUAL Basic-access review —
 *      the API returns authorization errors until the review passes.
 *   4. Explorer (read-only) access blocks KeywordPlanIdeaService entirely.
 *   5. ToS allows product use of Planner data; RESELLING raw Google data
 *      wholesale is restricted (§M6).
 * TODO(coordinator): implement KeywordPlanIdeaService generateKeywordIdeas
 * with the workspace's bound planner data_source credential. Until then this
 * raises PlannerNotReady and the miss path falls through to clickstream bulk.
 */
export async function plannerVolumeLookup(_keyword: string, _locale: string): Promise<VolumeLookupResult> {
  throw new PlannerNotReady();
}

export interface VolumeDeps {
  ttlDays?: number;
  maxTtlDays?: number;
  /** Override for tests. */
  planner?: typeof plannerVolumeLookup;
  /** Override for tests: (keyword, locale) → band + cost, or null if none. */
  vendorVolume?: (keyword: string, locale: string) => Promise<{ band: VolumeBand; costUsd: number } | null>;
  /** Override for tests — defaults to the Postgres store. */
  cache?: VolumeCacheStore;
  /** Override for tests — defaults to the real circuit breaker + meter. */
  budgetCheck?: (estimatedCostUsd: number) => Promise<void>;
  meter?: (vendor: string, costUsd: number) => Promise<void>;
  audit?: (summary: string) => Promise<void>;
}

/**
 * lookupVolume — volume is always a band, never a point.
 * Miss path order: cache → Keyword Planner (stub, TODO) → vendor clickstream bulk.
 * Every path checks the circuit breaker and meters into api_meter.
 */
export async function lookupVolume(
  workspaceId: string,
  keyword: string,
  locale: string,
  deps: VolumeDeps = {},
): Promise<VolumeLookupResult> {
  const ttlDays = deps.ttlDays ?? VOLUME_CACHE_TTL_DAYS;
  const maxTtlDays = deps.maxTtlDays ?? VOLUME_CACHE_MAX_TTL_DAYS;
  const cache = deps.cache ?? pgStore(workspaceId);
  const budgetCheck = deps.budgetCheck ?? ((est) => assertBudgetAvailable(workspaceId, est));
  const meterFn = deps.meter ?? ((vendor, cost) => recordApiMeter(workspaceId, vendor, "volume_lookup", 1, cost));
  const auditFn = deps.audit ?? ((s) => auditApiCall(workspaceId, "volumeLookup", s));
  const key = volumeCacheKey(keyword, locale);
  const now = new Date();

  // 1. Cache read (shared dedup cache; GUC satisfies the presence policy).
  const cached = await cache.read(key, locale);
  if (cached && isCacheFresh(cached.expiresAt, now)) {
    if (!isVolumeBand(cached.volumeBand)) {
      // Defensive: a non-band row must never leak to consumers.
      throw new Error(`volume_cache row for hash ${key.slice(0, 8)}… holds a non-band value — refusing to serve.`);
    }
    // Cache-invalidation-on-use: sliding refresh, hard-capped at max TTL.
    await cache.refresh(key, locale, refreshExpiry(cached.fetchedAt, ttlDays, maxTtlDays, now));
    // Per-workspace attribution: aggregate-counted, never attributed keywords.
    await meterFn("volume_cache", 0);
    await auditFn(`Volume "${keyword}" (${locale}): cache hit → band ${cached.volumeBand}`);
    return { band: cached.volumeBand as VolumeBand, source: "cache", fetchedAt: cached.fetchedAt };
  }

  // 2. Miss path: Keyword Planner first (free), then vendor clickstream bulk.
  const planner = deps.planner ?? plannerVolumeLookup;
  try {
    const result = await planner(keyword, locale);
    await storeAndMeter(workspaceId, cache, key, locale, result.band, "planner", 0, ttlDays, budgetCheck, meterFn, auditFn);
    return result;
  } catch (e) {
    if (!(e instanceof PlannerNotReady)) throw e;
    // fall through to clickstream bulk
  }

  const vendorVolume =
    deps.vendorVolume ??
    (async (kw: string, loc: string) => {
      const adapters = await buildSerpAdapters(workspaceId);
      // Prefer dataforseo for bulk clickstream; any vendor with the capability works.
      const order = ["dataforseo", "serper", "talordata"] as const;
      for (const v of order) {
        const a = adapters[v];
        if (a.isConfigured() && typeof a.getVolumeBand === "function") {
          try {
            return await a.getVolumeBand(kw, loc);
          } catch {
            continue;
          }
        }
      }
      return null;
    });

  const bulk = await vendorVolume(keyword, locale);
  if (!bulk) throw new VolumeUnavailableError(keyword);
  await storeAndMeter(workspaceId, cache, key, locale, bulk.band, "vendor", bulk.costUsd, ttlDays, budgetCheck, meterFn, auditFn);
  return { band: bulk.band, source: "vendor", fetchedAt: new Date() };
}

async function storeAndMeter(
  workspaceId: string,
  cache: VolumeCacheStore,
  key: string,
  locale: string,
  band: string,
  source: string,
  costUsd: number,
  ttlDays: number,
  budgetCheck: (est: number) => Promise<void>,
  meterFn: (vendor: string, cost: number) => Promise<void>,
  auditFn: (s: string) => Promise<void>,
): Promise<void> {
  if (!isVolumeBand(band)) {
    throw new Error(`Refusing to cache non-band volume value "${band}" — bands only, never points.`);
  }
  // Circuit breaker before paying for the miss.
  await budgetCheck(costUsd);
  await cache.write(key, locale, band as VolumeBand, source, ttlDays);
  await meterFn(source, costUsd);
  await auditFn(`Volume (${locale}): miss → ${source} band ${band}, $${costUsd.toFixed(6)}`);
}

/** Aggregate cache stats for the data-costs UI. Keywords are NEVER exposed —
 *  only counts. Uses the caller's workspace id as the system GUC (see the
 *  GUC quirk note at the top of this file). */
export async function getVolumeCacheStats(
  workspaceId: string,
): Promise<{ rows: number; totalHits: number; oldestFetchedAt: Date | null; freshestFetchedAt: Date | null }> {
  const agg = await withWorkspaceScope(workspaceId, (tx) =>
    tx.volumeCache.aggregate({
      _count: { _all: true },
      _sum: { hits: true },
      _min: { fetchedAt: true },
      _max: { fetchedAt: true },
    }),
  );
  return {
    rows: agg._count._all,
    totalHits: agg._sum.hits ?? 0,
    oldestFetchedAt: agg._min.fetchedAt,
    freshestFetchedAt: agg._max.fetchedAt,
  };
}
