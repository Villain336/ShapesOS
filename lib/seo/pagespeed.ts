// ShapesOS Phase 11 (seotools): Core Web Vitals from the PageSpeed Insights
// API v5 — Lighthouse lab data plus the CrUX field data Google returns in
// the same response (loadingExperience / originLoadingExperience).
//
//   GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed
//       ?url=…&strategy=mobile|desktop&category=performance[&key=PAGESPEED_API_KEY]
//
// PAGESPEED_API_KEY is optional: keyless calls work at a low shared quota.
// When the API can't measure (quota, unreachable page, network), the result
// is { unavailable: true, reason } — numbers are never invented. Field data
// is null when CrUX has no data for the URL or its origin (common for small
// sites); the lab numbers still come from a real Lighthouse run.
//
// Thresholds are Google's published "good / needs improvement / poor"
// boundaries (web.dev/vitals). CrUX's own category wins when present.

import { safeFetch } from "@/lib/connectors/safe-fetch";
import type { ResolveFn } from "@/lib/safe-url";
import type { ScanFinding } from "@/lib/audit/scanner";

export const PAGESPEED_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PAGESPEED_TIMEOUT_MS = 90_000;

export type VitalsRating = "good" | "needs-improvement" | "poor";
export type VitalsStrategy = "mobile" | "desktop";

export interface VitalsMetric {
  /** ms for timings, unitless for CLS. */
  value: number;
  rating: VitalsRating;
}

export interface FieldVitals {
  /** "url" = CrUX data for this exact page; "origin" = the whole site's. */
  scope: "url" | "origin";
  overall: VitalsRating | null;
  lcp: VitalsMetric | null;
  inp: VitalsMetric | null;
  cls: VitalsMetric | null;
  fcp: VitalsMetric | null;
  ttfb: VitalsMetric | null;
}

export interface LabVitals {
  /** Lighthouse performance score, 0–100. */
  performanceScore: number | null;
  lcp: VitalsMetric | null;
  cls: VitalsMetric | null;
  /** Total blocking time — the lab proxy for INP. */
  tbt: VitalsMetric | null;
  fcp: VitalsMetric | null;
  speedIndexMs: number | null;
  lighthouseVersion: string | null;
}

export interface StrategyVitals {
  strategy: VitalsStrategy;
  field: FieldVitals | null;
  lab: LabVitals;
}

export interface VitalsMeasured {
  unavailable?: false;
  source: "pagespeed-insights";
  url: string;
  measuredAt: string;
  /** True when PAGESPEED_API_KEY was used (keyless = shared low quota). */
  keyed: boolean;
  strategies: StrategyVitals[];
  /** Strategies that failed while others succeeded. */
  errors: { strategy: VitalsStrategy; reason: string }[];
}

export interface VitalsUnavailable {
  unavailable: true;
  source: "pagespeed-insights";
  url: string;
  measuredAt: string;
  reason: string;
}

export type VitalsResult = VitalsMeasured | VitalsUnavailable;

export interface VitalsOptions {
  apiKey?: string | null;
  strategies?: VitalsStrategy[];
  fetchImpl?: typeof fetch;
  /** DNS seam for the SSRF guard (tests). */
  resolve?: ResolveFn;
  timeoutMs?: number;
  now?: () => Date;
}

// Google's thresholds: [good max, needs-improvement max].
const THRESHOLDS = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
  tbt: [200, 600],
} as const;

export function rate(metric: keyof typeof THRESHOLDS, value: number): VitalsRating {
  const [good, ni] = THRESHOLDS[metric];
  return value <= good ? "good" : value <= ni ? "needs-improvement" : "poor";
}

function cruxCategory(c: unknown): VitalsRating | null {
  return c === "FAST" ? "good" : c === "AVERAGE" ? "needs-improvement" : c === "SLOW" ? "poor" : null;
}

type CruxMetric = { percentile?: number; category?: string };
type CruxBlock = { metrics?: Record<string, CruxMetric>; overall_category?: string; origin_fallback?: boolean } | undefined;

function fieldMetric(m: CruxMetric | undefined, key: keyof typeof THRESHOLDS, scale = 1): VitalsMetric | null {
  if (!m || typeof m.percentile !== "number" || !Number.isFinite(m.percentile)) return null;
  const value = m.percentile / scale;
  return { value, rating: cruxCategory(m.category) ?? rate(key, value) };
}

function parseField(block: CruxBlock, scope: "url" | "origin"): FieldVitals | null {
  const m = block?.metrics;
  if (!m || Object.keys(m).length === 0) return null;
  const field: FieldVitals = {
    scope,
    overall: cruxCategory(block?.overall_category),
    lcp: fieldMetric(m.LARGEST_CONTENTFUL_PAINT_MS, "lcp"),
    inp: fieldMetric(m.INTERACTION_TO_NEXT_PAINT, "inp"),
    // CrUX reports CLS ×100 (percentile 5 = 0.05).
    cls: fieldMetric(m.CUMULATIVE_LAYOUT_SHIFT_SCORE, "cls", 100),
    fcp: fieldMetric(m.FIRST_CONTENTFUL_PAINT_MS, "fcp"),
    ttfb: fieldMetric(m.EXPERIMENTAL_TIME_TO_FIRST_BYTE, "ttfb"),
  };
  return field.lcp || field.inp || field.cls ? field : null;
}

type LhAudit = { numericValue?: number };

function labMetric(a: LhAudit | undefined, key: keyof typeof THRESHOLDS): VitalsMetric | null {
  const v = a?.numericValue;
  return typeof v === "number" && Number.isFinite(v) ? { value: Math.round(v * 1000) / 1000, rating: rate(key, v) } : null;
}

/** Parse one runPagespeed JSON response. PURE. */
export function parsePagespeed(strategy: VitalsStrategy, json: unknown): StrategyVitals {
  const j = (json ?? {}) as {
    loadingExperience?: CruxBlock;
    originLoadingExperience?: CruxBlock;
    lighthouseResult?: {
      lighthouseVersion?: string;
      categories?: { performance?: { score?: number | null } };
      audits?: Record<string, LhAudit>;
    };
  };
  // Page-level CrUX first; Google sets origin_fallback when it substituted origin data.
  const page = j.loadingExperience;
  const field =
    (page && !page.origin_fallback ? parseField(page, "url") : null) ??
    parseField(page?.origin_fallback ? page : j.originLoadingExperience, "origin");
  const lh = j.lighthouseResult;
  const audits = lh?.audits ?? {};
  const score = lh?.categories?.performance?.score;
  const si = audits["speed-index"]?.numericValue;
  return {
    strategy,
    field,
    lab: {
      performanceScore: typeof score === "number" ? Math.round(score * 100) : null,
      lcp: labMetric(audits["largest-contentful-paint"], "lcp"),
      cls: labMetric(audits["cumulative-layout-shift"], "cls"),
      tbt: labMetric(audits["total-blocking-time"], "tbt"),
      fcp: labMetric(audits["first-contentful-paint"], "fcp"),
      speedIndexMs: typeof si === "number" ? Math.round(si) : null,
      lighthouseVersion: lh?.lighthouseVersion ?? null,
    },
  };
}

function apiError(status: number, body: unknown): string {
  const msg = (body as { error?: { message?: string } } | null)?.error?.message;
  if (status === 429) return "PageSpeed Insights quota exhausted — set PAGESPEED_API_KEY for a higher quota, or try later.";
  if (status === 400 && msg) return `PageSpeed Insights couldn't measure the page: ${msg.slice(0, 200)}`;
  if (status === 403) return "PageSpeed Insights refused the API key (check PAGESPEED_API_KEY).";
  return `PageSpeed Insights answered HTTP ${status}${msg ? `: ${msg.slice(0, 160)}` : ""}.`;
}

async function runStrategy(url: string, strategy: VitalsStrategy, opts: VitalsOptions, key: string | null): Promise<StrategyVitals> {
  const q = new URLSearchParams({ url, strategy, category: "performance" });
  if (key) q.set("key", key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PAGESPEED_TIMEOUT_MS);
  try {
    const res = await safeFetch(
      `${PAGESPEED_ENDPOINT}?${q.toString()}`,
      { headers: { Accept: "application/json" }, signal: controller.signal },
      { fetchFn: opts.fetchImpl, resolve: opts.resolve },
    );
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) throw new Error(apiError(res.status, body));
    const parsed = parsePagespeed(strategy, body);
    if (parsed.lab.performanceScore === null && !parsed.lab.lcp && !parsed.field) {
      throw new Error("PageSpeed Insights returned no measurements for this page.");
    }
    return parsed;
  } catch (err) {
    if (controller.signal.aborted) throw new Error("PageSpeed Insights timed out.");
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Measure a URL on each strategy (default mobile + desktop, in parallel). */
export async function fetchCoreWebVitals(url: string, opts: VitalsOptions = {}): Promise<VitalsResult> {
  const key = (opts.apiKey ?? process.env.PAGESPEED_API_KEY ?? "").trim() || null;
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const strategies = opts.strategies?.length ? opts.strategies : (["mobile", "desktop"] as VitalsStrategy[]);
  const settled = await Promise.allSettled(strategies.map((s) => runStrategy(url, s, opts, key)));
  const ok: StrategyVitals[] = [];
  const errors: { strategy: VitalsStrategy; reason: string }[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push(r.value);
    else errors.push({ strategy: strategies[i], reason: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  if (ok.length === 0) {
    return { unavailable: true, source: "pagespeed-insights", url, measuredAt: now, reason: errors[0]?.reason ?? "No measurement." };
  }
  return { source: "pagespeed-insights", url, measuredAt: now, keyed: !!key, strategies: ok, errors };
}

const LABEL = { lcp: "LCP", inp: "INP", cls: "CLS", tbt: "TBT" } as const;

function fmt(metric: keyof typeof LABEL, m: VitalsMetric): string {
  return metric === "cls" ? `${LABEL[metric]} ${m.value.toFixed(2)}` : `${LABEL[metric]} ${Math.round(m.value)} ms`;
}

/**
 * Audit findings from a measurement: one "poor-core-web-vitals" finding per
 * strategy whose real-user (field) LCP / INP / CLS is poor — or, with no
 * field data, whose lab LCP / CLS / TBT is poor (labelled lab). PURE.
 */
export function vitalsFindings(v: VitalsResult): ScanFinding[] {
  if (v.unavailable) return [];
  const out: ScanFinding[] = [];
  for (const s of v.strategies) {
    const fieldPoor = s.field
      ? (["lcp", "inp", "cls"] as const).filter((k) => s.field![k]?.rating === "poor").map((k) => fmt(k, s.field![k]!))
      : [];
    const labPoor = !s.field
      ? (["lcp", "cls", "tbt"] as const).filter((k) => s.lab[k]?.rating === "poor").map((k) => fmt(k, s.lab[k]!))
      : [];
    if (!fieldPoor.length && !labPoor.length) continue;
    const source = fieldPoor.length ? `real users (CrUX ${s.field!.scope === "origin" ? "origin-wide" : "this page"}, p75)` : "the lab (Lighthouse, no field data yet)";
    out.push({
      category: "poor-core-web-vitals",
      filePath: v.url,
      line: null,
      detail: `${s.strategy === "mobile" ? "Mobile" : "Desktop"} Core Web Vitals are poor for ${source}: ${(fieldPoor.length ? fieldPoor : labPoor).join(", ")}.`,
      fixHint: "Open the PageSpeed Insights report for the opportunities (image sizes, render-blocking scripts, layout shifts).",
      autoFixable: false,
    });
  }
  return out;
}
