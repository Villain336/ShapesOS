// Marketr — Phase 10 M3: citation-URL tracking.
//
// Which URLs get cited per engine per prompt, with domain normalization and
// citation-gap analysis: competitor domains cited where the brand's own
// domain is not. Pure functions over geo_observation rows (or the fixture
// shape in tests) — no DB here; summary.ts and the API routes supply rows.

import { perEngineShare, type HonestShare } from "./honesty";

/** Observation shape needed for citation analysis (DB row or fixture). */
export interface CitationObservation {
  /** promptIdx from stabilityMetadata, when available. */
  promptIdx: number | null;
  engine: string;
  citationUrls: string[];
  brandMentioned: boolean;
}

/**
 * Normalize a citation URL to its registrable-ish domain: lowercase host,
 * strip leading www., strip ports. Returns null for unparseable URLs.
 */
export function normalizeCitationDomain(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    if (!host || host.includes(" ")) return null;
    return host;
  } catch {
    return null;
  }
}

/** True when the URL belongs to one of the brand's owned domains. */
export function isOwnedCitation(url: string, ownedDomains: string[]): boolean {
  const d = normalizeCitationDomain(url);
  if (!d) return false;
  return ownedDomains.some((o) => {
    const od = o.toLowerCase().replace(/^www\./, "");
    return d === od || d.endsWith(`.${od}`);
  });
}

export interface PromptCitationList {
  promptIdx: number;
  engine: string;
  urls: string[];
  domains: string[];
  ownedCited: boolean;
}

/** Per-prompt, per-engine citation lists (deduped URLs, normalized domains). */
export function citationListsByPrompt(
  observations: CitationObservation[],
  ownedDomains: string[],
): PromptCitationList[] {
  const key = (o: CitationObservation) => `${o.promptIdx ?? -1}::${o.engine}`;
  const byKey = new Map<string, { promptIdx: number; engine: string; urls: Set<string> }>();
  for (const o of observations) {
    const k = key(o);
    let entry = byKey.get(k);
    if (!entry) {
      entry = { promptIdx: o.promptIdx ?? -1, engine: o.engine, urls: new Set() };
      byKey.set(k, entry);
    }
    for (const u of o.citationUrls) entry.urls.add(u);
  }
  return [...byKey.values()].map((e) => {
    const urls = [...e.urls];
    const domains = Array.from(
      new Set(urls.map(normalizeCitationDomain).filter((d): d is string => d !== null)),
    );
    return {
      promptIdx: e.promptIdx,
      engine: e.engine,
      urls,
      domains,
      ownedCited: urls.some((u) => isOwnedCitation(u, ownedDomains)),
    };
  });
}

/** Per-engine citation coverage of the owned domain, as an HonestShare. */
export function ownedCitationCoverage(
  observations: CitationObservation[],
  ownedDomains: string[],
): HonestShare[] {
  const byEngine = new Map<string, { withOwned: Set<number>; prompts: Set<number> }>();
  for (const o of observations) {
    if (o.promptIdx === null) continue;
    let e = byEngine.get(o.engine);
    if (!e) {
      e = { withOwned: new Set(), prompts: new Set() };
      byEngine.set(o.engine, e);
    }
    e.prompts.add(o.promptIdx);
    if (o.citationUrls.some((u) => isOwnedCitation(u, ownedDomains))) {
      e.withOwned.add(o.promptIdx);
    }
  }
  return [...byEngine.entries()].map(([engine, e]) =>
    perEngineShare(engine, e.withOwned.size, e.prompts.size),
  );
}

export interface CitationGap {
  promptIdx: number;
  /** Engines where a competitor is cited but the owned domain is not. */
  engines: string[];
  /** Competitor domains cited in those engines. */
  competitorDomains: string[];
  /** Example competitor URLs (up to 3) for the brief handoff. */
  competitorUrls: string[];
  /** Share of engines with the gap, as an honest metric. */
  gapShare: HonestShare;
}

interface CompetitorDomainInfo {
  domain: string;
  engines: Set<string>;
  urls: Set<string>;
}

/**
 * Citation-gap detection: for each prompt, find competitor domains cited by
 * engines that never cite the owned domain. Competitor domains are inferred
 * from non-owned cited domains (no external competitor list required), ranked
 * by prompt coverage.
 */
export function detectCitationGaps(
  observations: CitationObservation[],
  ownedDomains: string[],
  prompts?: string[],
): CitationGap[] {
  const lists = citationListsByPrompt(observations, ownedDomains);
  const byPrompt = new Map<number, PromptCitationList[]>();
  for (const l of lists) {
    const arr = byPrompt.get(l.promptIdx) ?? [];
    arr.push(l);
    byPrompt.set(l.promptIdx, arr);
  }
  const gaps: CitationGap[] = [];
  for (const [promptIdx, engineLists] of byPrompt) {
    if (promptIdx < 0) continue;
    const gapEngines = engineLists.filter((l) => !l.ownedCited);
    if (gapEngines.length === 0) continue;
    const competitors = new Map<string, CompetitorDomainInfo>();
    for (const l of gapEngines) {
      for (const url of l.urls) {
        const d = normalizeCitationDomain(url);
        if (!d || isOwnedCitation(url, ownedDomains)) continue;
        let info = competitors.get(d);
        if (!info) {
          info = { domain: d, engines: new Set(), urls: new Set() };
          competitors.set(d, info);
        }
        info.engines.add(l.engine);
        info.urls.add(url);
      }
    }
    if (competitors.size === 0) continue;
    const ranked = [...competitors.values()].sort(
      (a, b) => b.engines.size - a.engines.size || b.urls.size - a.urls.size,
    );
    const top = ranked.slice(0, 5);
    const urls = top.flatMap((t) => [...t.urls]).slice(0, 3);
    gaps.push({
      promptIdx,
      engines: [...new Set(gapEngines.map((l) => l.engine))].sort(),
      competitorDomains: top.map((t) => t.domain),
      competitorUrls: urls,
      gapShare: perEngineShare(
        "gap",
        gapEngines.length,
        engineLists.length,
      ),
    });
  }
  gaps.sort((a, b) => b.gapShare.share - a.gapShare.share || a.promptIdx - b.promptIdx);
  void prompts; // prompt text is joined by callers that own the panel
  return gaps;
}

/** Rank domains by total citation count across all observations. */
export function rankCitedDomains(
  observations: CitationObservation[],
  limit = 25,
): { domain: string; citations: number; engines: string[] }[] {
  const counts = new Map<string, { n: number; engines: Set<string> }>();
  for (const o of observations) {
    for (const u of o.citationUrls) {
      const d = normalizeCitationDomain(u);
      if (!d) continue;
      let c = counts.get(d);
      if (!c) {
        c = { n: 0, engines: new Set() };
        counts.set(d, c);
      }
      c.n += 1;
      c.engines.add(o.engine);
    }
  }
  return [...counts.entries()]
    .map(([domain, c]) => ({ domain, citations: c.n, engines: [...c.engines].sort() }))
    .sort((a, b) => b.citations - a.citations)
    .slice(0, limit);
}
