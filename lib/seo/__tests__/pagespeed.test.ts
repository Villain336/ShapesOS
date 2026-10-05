// ShapesOS Phase 11 (seotools): Core Web Vitals (PageSpeed Insights + CrUX).
// The PSI response below is a trimmed copy of the documented v5 shape; the
// API itself is stubbed (live calls are UNVERIFIED-LIVE in this suite).
// Run: npx tsx --test lib/seo/__tests__/pagespeed.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchCoreWebVitals, parsePagespeed, rate, vitalsFindings, PAGESPEED_ENDPOINT, type VitalsResult } from "../pagespeed";

const publicDns = async () => ["142.250.80.42"];

function psiFixture(opts: { fieldPage?: boolean; fieldOrigin?: boolean; lcpLab?: number; slow?: boolean } = {}) {
  const crux = (slow: boolean, fallback = false) => ({
    id: "https://acme.example/",
    origin_fallback: fallback || undefined,
    overall_category: slow ? "SLOW" : "FAST",
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: slow ? 4800 : 1900, category: slow ? "SLOW" : "FAST" },
      INTERACTION_TO_NEXT_PAINT: { percentile: slow ? 650 : 120, category: slow ? "SLOW" : "FAST" },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: slow ? 31 : 5, category: slow ? "SLOW" : "FAST" },
      FIRST_CONTENTFUL_PAINT_MS: { percentile: 1200, category: "FAST" },
      EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 500, category: "FAST" },
    },
  });
  return {
    id: "https://acme.example/",
    loadingExperience: opts.fieldPage ? crux(!!opts.slow) : { id: "https://acme.example/" },
    originLoadingExperience: opts.fieldOrigin ? crux(!!opts.slow) : undefined,
    lighthouseResult: {
      lighthouseVersion: "12.2.0",
      categories: { performance: { score: opts.slow ? 0.31 : 0.94 } },
      audits: {
        "largest-contentful-paint": { numericValue: opts.lcpLab ?? 1834.4 },
        "cumulative-layout-shift": { numericValue: 0.0123 },
        "total-blocking-time": { numericValue: opts.slow ? 900 : 40 },
        "first-contentful-paint": { numericValue: 900.2 },
        "speed-index": { numericValue: 2100.7 },
      },
    },
  };
}

function stubFetch(handler: (url: URL) => { status: number; json: unknown }) {
  const calls: URL[] = [];
  const fn = (async (input: string) => {
    const u = new URL(input);
    calls.push(u);
    const r = handler(u);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("parsePagespeed", () => {
  it("reads page-level CrUX field data and Lighthouse lab data", () => {
    const v = parsePagespeed("mobile", psiFixture({ fieldPage: true }));
    assert.equal(v.field?.scope, "url");
    assert.equal(v.field?.overall, "good");
    assert.deepEqual(v.field?.lcp, { value: 1900, rating: "good" });
    assert.deepEqual(v.field?.cls, { value: 0.05, rating: "good" }, "CrUX CLS is reported ×100");
    assert.equal(v.field?.inp?.value, 120);
    assert.equal(v.lab.performanceScore, 94);
    assert.deepEqual(v.lab.lcp, { value: 1834.4, rating: "good" });
    assert.equal(v.lab.speedIndexMs, 2101);
    assert.equal(v.lab.lighthouseVersion, "12.2.0");
  });

  it("falls back to origin field data, and to none", () => {
    assert.equal(parsePagespeed("mobile", psiFixture({ fieldOrigin: true })).field?.scope, "origin");
    assert.equal(parsePagespeed("mobile", psiFixture({})).field, null);
    assert.equal(parsePagespeed("desktop", {}).lab.performanceScore, null);
  });

  it("rates with Google's thresholds", () => {
    assert.equal(rate("lcp", 2500), "good");
    assert.equal(rate("lcp", 2501), "needs-improvement");
    assert.equal(rate("inp", 501), "poor");
    assert.equal(rate("cls", 0.1), "good");
    assert.equal(rate("cls", 0.26), "poor");
  });
});

describe("fetchCoreWebVitals", () => {
  it("measures mobile and desktop, passing the key only when set", async () => {
    const { fn, calls } = stubFetch(() => ({ status: 200, json: psiFixture({ fieldPage: true }) }));
    const v = await fetchCoreWebVitals("https://acme.example/", { fetchImpl: fn, resolve: publicDns, apiKey: "k-123", now: () => new Date("2026-10-04T00:00:00Z") });
    assert.equal(v.unavailable, undefined);
    if (v.unavailable) return;
    assert.deepEqual(v.strategies.map((s) => s.strategy), ["mobile", "desktop"]);
    assert.equal(v.keyed, true);
    assert.equal(v.measuredAt, "2026-10-04T00:00:00.000Z");
    assert.equal(calls.length, 2);
    assert.equal(`${calls[0].origin}${calls[0].pathname}`, PAGESPEED_ENDPOINT);
    assert.equal(calls[0].searchParams.get("url"), "https://acme.example/");
    assert.equal(calls[0].searchParams.get("category"), "performance");
    assert.equal(calls[0].searchParams.get("key"), "k-123");

    const keyless = stubFetch(() => ({ status: 200, json: psiFixture({}) }));
    const saved = process.env.PAGESPEED_API_KEY;
    delete process.env.PAGESPEED_API_KEY;
    try {
      const k = await fetchCoreWebVitals("https://acme.example/", { fetchImpl: keyless.fn, resolve: publicDns, strategies: ["mobile"] });
      assert.equal(keyless.calls[0].searchParams.has("key"), false);
      assert.equal(!k.unavailable && k.keyed, false);
    } finally {
      if (saved !== undefined) process.env.PAGESPEED_API_KEY = saved;
    }
  });

  it("is unavailable (never invented) when every strategy fails", async () => {
    const quota = stubFetch(() => ({ status: 429, json: { error: { code: 429, message: "Quota exceeded" } } }));
    const v = await fetchCoreWebVitals("https://acme.example/", { fetchImpl: quota.fn, resolve: publicDns });
    assert.equal(v.unavailable, true);
    assert.match(v.unavailable ? v.reason : "", /quota exhausted/);

    const bad = stubFetch(() => ({ status: 400, json: { error: { message: "Lighthouse returned error: FAILED_DOCUMENT_REQUEST" } } }));
    const b = await fetchCoreWebVitals("https://acme.example/", { fetchImpl: bad.fn, resolve: publicDns, strategies: ["mobile"] });
    assert.match(b.unavailable ? b.reason : "", /FAILED_DOCUMENT_REQUEST/);

    const empty = stubFetch(() => ({ status: 200, json: {} }));
    const e = await fetchCoreWebVitals("https://acme.example/", { fetchImpl: empty.fn, resolve: publicDns, strategies: ["mobile"] });
    assert.match(e.unavailable ? e.reason : "", /no measurements/);
  });

  it("keeps the strategies that worked and records the ones that didn't", async () => {
    const mixed = stubFetch((u) =>
      u.searchParams.get("strategy") === "mobile" ? { status: 200, json: psiFixture({}) } : { status: 500, json: {} },
    );
    const v = await fetchCoreWebVitals("https://acme.example/", { fetchImpl: mixed.fn, resolve: publicDns });
    assert.ok(!v.unavailable);
    if (v.unavailable) return;
    assert.equal(v.strategies.length, 1);
    assert.equal(v.errors[0].strategy, "desktop");
  });
});

describe("vitalsFindings", () => {
  const measured = (json: unknown): VitalsResult => ({
    source: "pagespeed-insights",
    url: "https://acme.example/",
    measuredAt: "x",
    keyed: false,
    strategies: [parsePagespeed("mobile", json)],
    errors: [],
  });

  it("flags poor field vitals with the metrics and scope", () => {
    const f = vitalsFindings(measured(psiFixture({ fieldPage: true, slow: true })));
    assert.equal(f.length, 1);
    assert.equal(f[0].category, "poor-core-web-vitals");
    assert.match(f[0].detail, /Mobile .* real users \(CrUX this page, p75\): LCP 4800 ms, INP 650 ms, CLS 0\.31/);
    assert.equal(f[0].autoFixable, false);
  });

  it("uses lab data only when there is no field data", () => {
    const lab = vitalsFindings(measured(psiFixture({ lcpLab: 5200, slow: true })));
    assert.match(lab[0].detail, /the lab \(Lighthouse, no field data yet\): LCP 5200 ms, TBT 900 ms/);
    assert.deepEqual(vitalsFindings(measured(psiFixture({ fieldPage: true }))), []);
    assert.deepEqual(vitalsFindings({ unavailable: true, source: "pagespeed-insights", url: "u", measuredAt: "x", reason: "r" }), []);
  });
});
