// Marketr — Phase 6 I1: 90-day Growth Plan compiler.
//
// Ranked initiatives mapped to the Marketr module that executes each.
// Human-reviewable, adjustable priorities (adjustedByHuman flag).

import type {
  AuditResult, GrowthPlan, PlanInitiative, RevenueOpportunity,
} from "./types";

let seq = 0;
function init(i: Omit<PlanInitiative, "id" | "priority">): PlanInitiative {
  seq += 1;
  return { ...i, id: `init-${seq}`, priority: seq };
}

const SPRINT_MODULE: Record<string, { sprint: 30 | 60 | 90; module: string; effort: "low" | "medium" | "high" }> = {
  "speed-to-lead": { sprint: 30, module: "CRM (Phase 1)", effort: "low" },
  "analytics": { sprint: 30, module: "Website (fix-agent ladder)", effort: "low" },
  "schema": { sprint: 30, module: "Website (fix-agent ladder)", effort: "low" },
  "pixel": { sprint: 30, module: "Website (fix-agent ladder)", effort: "low" },
  "brand-voice": { sprint: 30, module: "Brand kit", effort: "low" },
  "review-velocity": { sprint: 30, module: "Reviews (Phase 3)", effort: "low" },
  "funnel-leak": { sprint: 30, module: "CRM + Nurture (Phase 1/3)", effort: "medium" },
  "nurture": { sprint: 60, module: "Nurture (Phase 3)", effort: "medium" },
  "decay": { sprint: 60, module: "Content engine + SEO", effort: "medium" },
  "gaps": { sprint: 60, module: "Content engine", effort: "medium" },
  "outreach": { sprint: 60, module: "Outreach (Phase 6 O1)", effort: "high" },
  "aeo": { sprint: 90, module: "AEO (Phase 6 A1)", effort: "medium" },
};

const PLAN_COPY: Record<string, { title: string; description: string; expectedOutcome: string }> = {
  "speed-to-lead": {
    title: "Speed-to-lead triage cadence",
    description: "No lead sits in \"new\" longer than 4 business hours. Daily triage + first-response templates.",
    expectedOutcome: "Recover 10–20% of leads that would have gone cold.",
  },
  "analytics": {
    title: "Install analytics",
    description: "GA4 (or equivalent) on every page with conversion events wired to the CRM.",
    expectedOutcome: "Every future dollar of traffic becomes measurable.",
  },
  "schema": {
    title: "Ship Organization + LocalBusiness schema",
    description: "Structured data on the homepage and key pages — the citability foundation.",
    expectedOutcome: "+39% citation impact per the GEO16 pillar research.",
  },
  "pixel": {
    title: "Install the Meta pixel",
    description: "Start the 30-day retargeting warmup clock before any paid push.",
    expectedOutcome: "Warm retargeting pools ready for the first paid sprint.",
  },
  "brand-voice": {
    title: "Document brand voice",
    description: "One page: tone, do/don't examples, reply style. Feeds the brand kit and AI copy.",
    expectedOutcome: "Consistent copy across site, ads, social, and review replies.",
  },
  "review-velocity": {
    title: "Turn on smart-timing review requests",
    description: "CRM/POS webhook → request at the right moment; every reply drafted in the approval queue.",
    expectedOutcome: "Compounding rating position; the local-pack tiebreaker.",
  },
  "funnel-leak": {
    title: "Fix the biggest funnel leak",
    description: "Follow-up sequence + response SLA at the exact stage handoff losing the most leads.",
    expectedOutcome: "Highest-ROI funnel fix — measured in recovered deals.",
  },
  "nurture": {
    title: "Activate a nurture sequence",
    description: "One active sequence for stalled leads; supervised sends, daily caps.",
    expectedOutcome: "Non-ready leads stay warm instead of decaying.",
  },
  "decay": {
    title: "Work the content refresh queue",
    description: "Refresh decaying pages (decay engine, ranked by score) before commissioning net-new.",
    expectedOutcome: "Recovered positions at a fraction of new-content cost.",
  },
  "gaps": {
    title: "Fill keyword-to-content gaps",
    description: "Content-engine briefs for researched keywords with no ranking page.",
    expectedOutcome: "New ranking surface on already-researched demand.",
  },
  "outreach": {
    title: "Launch depth-1 guest-post prospecting",
    description: "Prospect discovery + scoring against the competitor backlink graph. No sending at depth 1.",
    expectedOutcome: "Qualified placement pipeline for authority building.",
  },
  "aeo": {
    title: "Start weekly AEO tracking",
    description: "Versioned prompt set, 4 engines, N=3 reps — measure brand presence in AI answers, then act.",
    expectedOutcome: "Per-engine visibility baseline + first owned-domain fixes.",
  },
};

/** Map an opportunity title to a plan key (best-effort keyword match). */
function keyFor(opp: RevenueOpportunity): string | null {
  const t = (opp.title + " " + opp.description).toLowerCase();
  for (const k of Object.keys(PLAN_COPY)) {
    if (t.includes(k.replace("-", " ")) || t.includes(k)) return k;
  }
  return null;
}

export function compilePlan(
  opportunities: RevenueOpportunity[],
  audits: AuditResult[],
): GrowthPlan {
  seq = 0;
  const used = new Set<string>();
  const initiatives: PlanInitiative[] = [];

  for (const opp of opportunities) {
    const key = keyFor(opp);
    if (!key || used.has(key)) continue;
    used.add(key);
    const cfg = SPRINT_MODULE[key];
    const copy = PLAN_COPY[key];
    initiatives.push(init({
      title: copy.title, description: copy.description,
      sprint: cfg.sprint, module: cfg.module,
      expectedOutcome: copy.expectedOutcome, effort: cfg.effort,
      auditId: opp.auditId,
    }));
  }

  // Always-on foundations that don't derive from a specific opportunity.
  const foundations = ["analytics", "schema"] as const;
  const auditIds = new Set(audits.map((a) => a.id));
  for (const key of foundations) {
    if (!used.has(key) && auditIds.has("technology")) {
      const cfg = SPRINT_MODULE[key];
      const copy = PLAN_COPY[key];
      initiatives.push(init({
        title: copy.title, description: copy.description,
        sprint: cfg.sprint, module: cfg.module,
        expectedOutcome: copy.expectedOutcome, effort: cfg.effort,
        auditId: "technology",
      }));
    }
  }

  // Order: 30-day sprint first, then 60, then 90; within sprint keep derivation order.
  initiatives.sort((a, b) => a.sprint - b.sprint || a.priority - b.priority);
  initiatives.forEach((i, idx) => { i.priority = idx + 1; });

  return { initiatives, generatedAt: new Date().toISOString() };
}

/** Human reprioritization: reorder initiatives by id list; flags adjusted ones. */
export function reprioritize(plan: GrowthPlan, orderedIds: string[]): GrowthPlan {
  const byId = new Map(plan.initiatives.map((i) => [i.id, i]));
  const reordered: PlanInitiative[] = [];
  let p = 1;
  for (const id of orderedIds) {
    const i = byId.get(id);
    if (!i) continue;
    reordered.push({ ...i, priority: p++, adjustedByHuman: true });
    byId.delete(id);
  }
  for (const i of plan.initiatives) {
    if (byId.has(i.id)) reordered.push({ ...i, priority: p++ });
  }
  return { ...plan, initiatives: reordered };
}
