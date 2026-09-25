// Marketr — Phase 6 I1: revenue opportunities, ranked by expected impact × effort.
//
// Opportunities are DERIVED from audit findings — never invented. Impact USD
// figures are explicit estimates (labeled as such in the UI); the ranking
// key is impactScore = impactUsd / effort, confidence-weighted.

import type { AuditResult, RevenueOpportunity } from "./types";

let seq = 0;
function opp(o: Omit<RevenueOpportunity, "id" | "impactScore">): RevenueOpportunity {
  seq += 1;
  const impactScore = Math.round((o.impactUsd / o.effort) * (o.confidence === "high" ? 1 : o.confidence === "medium" ? 0.7 : 0.4));
  return { ...o, id: `opp-${seq}`, impactScore };
}

export function deriveOpportunities(audits: AuditResult[]): RevenueOpportunity[] {
  seq = 0;
  const out: RevenueOpportunity[] = [];
  const byId = new Map(audits.map((a) => [a.id, a]));
  const has = (id: string, re: RegExp) =>
    byId.get(id as never)?.findings.some((f) => re.test(f.title + " " + f.detail)) ?? false;

  // Funnel leak → fix the handoff.
  if (has("conversion", /leak/i)) {
    out.push(opp({
      title: "Fix the biggest funnel leak",
      description: "The conversion audit names the exact stage handoff losing the most leads. A follow-up sequence + faster first response at that handoff is the highest-ROI move in the funnel.",
      impactUsd: 48000, effort: 2, confidence: "high",
      executesIn: "CRM + Nurture (Phase 1/3)", auditId: "conversion",
    }));
  }
  // Stale leads → speed-to-lead triage.
  if (has("crm", /untouched/i)) {
    out.push(opp({
      title: "Speed-to-lead triage sprint",
      description: "Leads are sitting untouched in \"new\" past 24 hours. A same-day triage cadence recovers deals that would otherwise go cold.",
      impactUsd: 30000, effort: 1, confidence: "high",
      executesIn: "CRM (Phase 1)", auditId: "crm",
    }));
  }
  // Review velocity → more 5-star proof.
  if (has("reputation", /velocity|request/i)) {
    out.push(opp({
      title: "Turn on review velocity",
      description: "The request engine is configured but underused. Smart-timed requests after every transaction compound into the rating position that wins local packs.",
      impactUsd: 36000, effort: 2, confidence: "medium",
      executesIn: "Reviews (Phase 3) → Approval queue (Phase 6 R1)", auditId: "reputation",
    }));
  }
  // Decaying content → refresh before net-new.
  if (has("content", /decay/i) || has("seo", /decay/i)) {
    out.push(opp({
      title: "Refresh decaying pages before writing new ones",
      description: "Pages the decay engine flagged are cheaper to rescue than new pages are to rank. Work the refresh queue first.",
      impactUsd: 24000, effort: 2, confidence: "medium",
      executesIn: "Content engine + SEO", auditId: "content",
    }));
  }
  // Keywords without content → brief queue.
  if (has("content", /no content/i)) {
    out.push(opp({
      title: "Fill the keyword-to-content gaps",
      description: "Researched keywords with no ranking content are briefs waiting to happen — the content engine can draft them this week.",
      impactUsd: 20000, effort: 3, confidence: "medium",
      executesIn: "Content engine", auditId: "content",
    }));
  }
  // Missing analytics → measurement first.
  if (has("technology", /no analytics/i)) {
    out.push(opp({
      title: "Install analytics before spending on traffic",
      description: "No analytics detected on the homepage. Every paid or outreach dollar spent without measurement is un-judgeable.",
      impactUsd: 15000, effort: 1, confidence: "high",
      executesIn: "Website (fix-agent ladder)", auditId: "technology",
    }));
  }
  // Structured data → AEO citability.
  if (has("technology", /structured data/i)) {
    out.push(opp({
      title: "Add Organization + LocalBusiness schema",
      description: "The cheapest AI-visibility win in the report — structured data is the top citability pillar (r=0.63, +39% citation impact).",
      impactUsd: 12000, effort: 1, confidence: "high",
      executesIn: "Website (fix-agent ladder) → AEO (Phase 6 A1)", auditId: "technology",
    }));
  }
  // No pixels → retargeting warmup.
  if (has("technology", /no ad pixels/i)) {
    out.push(opp({
      title: "Install the Meta pixel now",
      description: "Retargeting audiences need 30+ days of history. Install today so the first paid push has warm pools.",
      impactUsd: 18000, effort: 1, confidence: "medium",
      executesIn: "Website (fix-agent ladder)", auditId: "technology",
    }));
  }
  // Competitor gap → outreach targets.
  if (has("competitor-map", /competitors mapped/i)) {
    out.push(opp({
      title: "Steal competitor backlinks via outreach",
      description: "The competitor map shows who links to rivals. Depth-1 prospecting turns their link graph into your outreach list.",
      impactUsd: 28000, effort: 3, confidence: "medium",
      executesIn: "Outreach (Phase 6 O1)", auditId: "competitor-map",
    }));
  }
  // Brand voice missing → consistency.
  if (has("brand", /brand voice/i)) {
    out.push(opp({
      title: "Document brand voice to stop copy drift",
      description: "Without a voice guide, AI copy and review replies drift between channels. One page of tone guidance fixes it everywhere.",
      impactUsd: 8000, effort: 1, confidence: "high",
      executesIn: "Brand kit", auditId: "brand",
    }));
  }
  // AIO presence → AEO tracking.
  if (has("seo", /AI Overview/i)) {
    out.push(opp({
      title: "Track brand presence in AI Overviews",
      description: "AI Overviews are covering your money keywords. The AEO track measures whether your brand appears inside them — then acts.",
      impactUsd: 22000, effort: 2, confidence: "medium",
      executesIn: "AEO (Phase 6 A1)", auditId: "seo",
    }));
  }
  // Nurture missing → sequence.
  if (has("crm", /nurture/i)) {
    out.push(opp({
      title: "Activate a nurture sequence for stalled leads",
      description: "Non-ready leads go cold without follow-up. One active sequence keeps the pipeline warm on autopilot (supervised).",
      impactUsd: 26000, effort: 2, confidence: "medium",
      executesIn: "Nurture (Phase 3)", auditId: "crm",
    }));
  }

  // Rank: impact × (1/effort), confidence-weighted — highest first.
  out.sort((a, b) => b.impactScore - a.impactScore);
  return out;
}
