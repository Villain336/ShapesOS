// ShapesOS — Phase 21A (WS=agentweb): de-duplication, trust and freshness
// scoring, and ranking of search results (PURE).
//
// We rent breadth from search providers and own the layer above it: ranking for
// trust and freshness. Trust is a heuristic over SOURCE QUALITY signals, not
// SEO: it can be wrong about an individual site, which is why every answer shows
// where each claim came from.
//
//   trust     0.5 base; https +0.05, http -0.1; government / education / health
//             bodies +0.3; reference and standards bodies +0.25; major news +0.2;
//             a bare IP address -0.3; coupon / affiliate patterns -0.2; a very
//             long query string -0.1. Workspace results are 1. Clamped to 0..1.
//   freshness <=7 days 1, <=30 0.85, <=180 0.65, <=365 0.5, older 0.3 (0.1 when
//             the question needs recent information); unknown 0.5 (0.3 recent).
//   score     0.45 relevance + 0.35 trust + 0.20 freshness; when recent matters
//             0.30 / 0.30 / 0.40. Relevance is the provider's own position
//             (1 - 0.08 per place), +0.05 when two providers agree.

import type { SearchResult, Source } from "./types";

const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref_src|ref|igshid|_hsenc|_hsmi)$/i;

export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
  return `${u.protocol}//${u.host}${path === "/" && !u.search ? "" : path}${u.search}`;
}

const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const jaccard = (a: string, b: string) => {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both += 1;
  return both / (A.size + B.size - both);
}

export interface Merged extends SearchResult {
  providers: string[];
  /** Best (lowest) position any provider gave it. */
  position: number;
}

export function dedupe(results: SearchResult[]): Merged[] {
  const out: Merged[] = [];
  const byUrl = new Map<string, Merged>();
  const perProvider = new Map<string, number>();
  for (const res of results) {
    const pos = perProvider.get(res.provider) ?? 0;
    perProvider.set(res.provider, pos + 1);
    const key = normalizeUrl(res.url);
    const have = byUrl.get(key);
    if (have) {
      if (!have.providers.includes(res.provider)) have.providers.push(res.provider);
      if (res.snippet.length > have.snippet.length) have.snippet = res.snippet;
      have.position = Math.min(have.position, pos);
      have.publishedAt ??= res.publishedAt;
      continue;
    }
    const tk = titleKey(res.title);
    const twin = out.find((o) => normalizeUrl(o.url).split("/")[2] !== key.split("/")[2] && tk.length > 12 && jaccard(titleKey(o.title), tk) >= 0.9);
    if (twin) {
      if (!twin.providers.includes(res.provider)) twin.providers.push(res.provider);
      continue;
    }
    const m: Merged = { ...res, providers: [res.provider], position: pos };
    byUrl.set(key, m);
    out.push(m);
  }
  return out;
}

const GOV = /(\.(gov|edu|mil)$|\.(gov|ac|edu)\.[a-z]{2}$|\.nhs\.uk$)/;
const REFERENCE = /(^|\.)(wikipedia\.org|mozilla\.org|w3\.org|ietf\.org|iso\.org|who\.int|europa\.eu|nature\.com|arxiv\.org)$/;
const NEWS = /(^|\.)(reuters\.com|apnews\.com|bbc\.com|bbc\.co\.uk)$/;
const FARM = /(coupon|promo-code|free-download|top-\d+-best|best-\d+-)/i;

export function trustScore(url: string, provider = "web"): number {
  if (provider === "workspace") return 1;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 0.2;
  }
  let t = 0.5 + (u.protocol === "https:" ? 0.05 : -0.1);
  const host = u.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) t -= 0.3;
  else if (GOV.test(host)) t += 0.3;
  else if (REFERENCE.test(host)) t += 0.25;
  else if (NEWS.test(host)) t += 0.2;
  if (FARM.test(u.pathname) || /(^|&)(aff|affiliate|ref)=/i.test(u.search.slice(1))) t -= 0.2;
  if (u.search.length > 120) t -= 0.1;
  return Math.round(Math.min(1, Math.max(0, t)) * 100) / 100;
}

export function freshnessScore(publishedAt: string | undefined, now: Date, recent: boolean): number {
  const t = publishedAt ? Date.parse(publishedAt) : NaN;
  if (!Number.isFinite(t)) return recent ? 0.3 : 0.5;
  const days = Math.max(0, (now.getTime() - t) / 86_400_000);
  if (days <= 7) return 1;
  if (days <= 30) return 0.85;
  if (days <= 180) return 0.65;
  if (days <= 365) return 0.5;
  return recent ? 0.1 : 0.3;
}

export const SOURCE_TEXT_CAP = 1200;

export function rankResults(results: SearchResult[], opts: { now?: Date; recent: boolean }): Source[] {
  const now = opts.now ?? new Date();
  const [wRel, wTrust, wFresh] = opts.recent ? [0.3, 0.3, 0.4] : [0.45, 0.35, 0.2];
  return dedupe(results)
    .map((m) => {
      const isWorkspace = m.providers.includes("workspace");
      const trust = trustScore(m.url, isWorkspace ? "workspace" : m.provider);
      const freshness = isWorkspace ? 1 : freshnessScore(m.publishedAt, opts.now ?? now, opts.recent);
      const relevance = 1 - Math.min(m.position, 9) * 0.08 + (m.providers.length > 1 ? 0.05 : 0);
      return {
        url: m.url,
        title: m.title,
        text: m.snippet.slice(0, SOURCE_TEXT_CAP),
        publishedAt: m.publishedAt,
        providers: m.providers,
        trust,
        freshness,
        score: Math.round((wRel * relevance + wTrust * trust + wFresh * freshness) * 1000) / 1000,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((s, i) => ({ ...s, id: i + 1 }));
}

/** The model's reranking, checked: ids it knows, in its order, nothing lost. Null when unusable. */
export function validateRerank(order: unknown, n: number): number[] | null {
  if (!Array.isArray(order)) return null;
  const seen = new Set<number>();
  for (const x of order) if (Number.isInteger(x) && x >= 1 && x <= n && !seen.has(x)) seen.add(x);
  if (seen.size * 2 < Math.min(n, order.length || n) || seen.size === 0) return null;
  const out = [...seen];
  for (let i = 1; i <= n; i++) if (!seen.has(i)) out.push(i);
  return out;
}
