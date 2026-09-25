// Marketr — A1 AEO: source-impact ranking.
// Which sources actually move the needle: citation frequency + citation
// efficiency (citations per URL) + co-occurrence lift, per engine, over run
// history. High-lift domains are where the act leg spends effort.

import { prisma } from "@/lib/prisma";
import { domainOf, type ScorableMention } from "./scoring";
import { isRecommended } from "./judge";
import type { AeoEngineName } from "./engines";

export interface SourceImpactRow {
  engine: AeoEngineName;
  domain: string;
  /** How many responses cited this domain. */
  citationFrequency: number;
  /** citations ÷ distinct URLs — >1 means multiple distinct URLs from the domain got cited. */
  citationEfficiency: number;
  /** P(brand recommended | source cited) − P(brand recommended | source not cited). */
  cooccurrenceLift: number;
  urls: string[];
}

/** Compute impact rows for ONE engine from its mentions (per-engine only). */
export function computeSourceImpact(
  engine: AeoEngineName,
  mentions: ScorableMention[],
): SourceImpactRow[] {
  const byDomain = new Map<string, { urls: Set<string>; citing: ScorableMention[] }>();
  const domainOfResponse = new Map<ScorableMention, Set<string>>();

  for (const m of mentions) {
    const domains = new Set<string>();
    for (const src of m.citedSources ?? []) {
      const domain = domainOf(src);
      if (!domain) continue;
      domains.add(domain);
      let entry = byDomain.get(domain);
      if (!entry) {
        entry = { urls: new Set<string>(), citing: [] };
        byDomain.set(domain, entry);
      }
      entry.urls.add(src.trim());
      if (!entry.citing.includes(m)) entry.citing.push(m);
    }
    domainOfResponse.set(m, domains);
  }

  const recommended = (m: ScorableMention) => isRecommended(m.mentioned, m.position, m.sentiment);
  const rows: SourceImpactRow[] = [];

  for (const [domain, entry] of byDomain) {
    const citing = entry.citing;
    const notCiting = mentions.filter((m) => !domainOfResponse.get(m)?.has(domain));
    const pRecGivenCited = citing.length === 0 ? 0 : citing.filter(recommended).length / citing.length;
    const pRecGivenNotCited = notCiting.length === 0 ? 0 : notCiting.filter(recommended).length / notCiting.length;
    rows.push({
      engine,
      domain,
      citationFrequency: citing.length,
      citationEfficiency: entry.urls.size === 0 ? 0 : citing.length / entry.urls.size,
      cooccurrenceLift: pRecGivenCited - pRecGivenNotCited,
      urls: [...entry.urls],
    });
  }

  // Defensible ranking: lift first (it measures impact), frequency breaks ties.
  rows.sort((a, b) => b.cooccurrenceLift - a.cooccurrenceLift || b.citationFrequency - a.citationFrequency);
  return rows;
}

/** Refresh the persisted aeo_source_impact rows from run history (per engine). */
export async function refreshSourceImpact(
  workspaceId: string,
  engine?: AeoEngineName,
): Promise<{ engine: AeoEngineName; domains: number }[]> {
  const engines: AeoEngineName[] = engine
    ? [engine]
    : ["openai", "anthropic", "gemini", "perplexity"];
  const out: { engine: AeoEngineName; domains: number }[] = [];
  for (const e of engines) {
    const mentions = await prisma.aeoMention.findMany({
      where: { run: { workspaceId, engine: e } },
      orderBy: { promptIdx: "asc" },
    });
    const rows = computeSourceImpact(
      e,
      mentions.map((m) => ({
        promptIdx: m.promptIdx,
        rep: m.rep,
        mentioned: m.mentioned,
        position: m.position,
        sentiment: m.sentiment as "positive" | "neutral" | "negative" | null,
        competitors: m.competitors,
        citedSources: m.citedSources,
      })),
    );
    for (const row of rows) {
      await prisma.aeoSourceImpact.upsert({
        where: { workspaceId_engine_domain: { workspaceId, engine: e, domain: row.domain } },
        update: {
          citationFrequency: row.citationFrequency,
          citationEfficiency: row.citationEfficiency,
          cooccurrenceLift: row.cooccurrenceLift,
          computedAt: new Date(),
        },
        create: {
          workspaceId,
          engine: e,
          domain: row.domain,
          citationFrequency: row.citationFrequency,
          citationEfficiency: row.citationEfficiency,
          cooccurrenceLift: row.cooccurrenceLift,
        },
      });
    }
    out.push({ engine: e, domains: rows.length });
  }
  return out;
}
