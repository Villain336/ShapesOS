// ShapesOS — Phase 19B (WS=panel): the panel report and the run diff.
// Commercial layer (entitlement dress_rehearsal). Licence boundary: CONTRIBUTING.md (open vs commercial; company-authored).
//
// Ported from the prototype's src/reporting/aggregate.ts. The report is:
//   * the DISTRIBUTION — who landed in each bucket, by name, plus the personas
//     whose verdict was withheld and why. Never a single percentage;
//   * ranked objection clusters across personas (token Jaccard ≥ 0.5,
//     single linkage; ranked by Σ severity weights), each with the interview
//     words behind it and the transcripts they come from;
//   * section heat (where attention died);
//   * suggested fixes (one structured model call per top cluster, max 5).
// Every report object carries SYNTHETIC_DISCLAIMER.
//
// Added for ShapesOS: diffReports() compares two runs of the same page
// ("objection #2 went from 3 of 5 personas to 1 of 5"); fixes stop cleanly
// at the run's credit cap (the report says how many were skipped).

import { z } from "zod";
import { isCapReached } from "./budget";
import type { PanelModel } from "./model";
import type { ObjectionSeverity } from "./persona";
import { tokenize } from "./memory";
import type { FrictionTimeline } from "./timeline";
import type { InterviewTrace } from "./trace";
import type { PersonaVerdict, VerdictChoice, VerdictOutcome, WithheldReason } from "./verdicts";

/** Shown on every report object and every report screen. */
export const SYNTHETIC_DISCLAIMER = "Synthetic panel output. Not human data. Treat as directional signals, never certainties.";

export interface ObjectionClusterInput {
  quote: string;
  section: string;
  severity: ObjectionSeverity;
  sourceTranscriptId?: string;
  interview?: InterviewTrace | null;
  personaKey: string;
  personaName: string;
}

export interface ObjectionCluster {
  representativeQuote: string;
  count: number;
  personaKeys: string[];
  personaNames: string[];
  sections: string[];
  sourceTranscriptIds: string[];
  /** Real interview words behind the cluster (deduped); empty = not supported by any interview. */
  interviewQuotes: InterviewTrace[];
  severity: ObjectionSeverity;
}

export interface SectionHeatRow {
  name: string;
  avgDwellMs: number;
  totalFriction: number;
  bounceCount: number;
  /** Personas whose walk touched the section. */
  personas: number;
}

export interface FixSuggestion {
  objection: string;
  suggestedFix: string;
  expectedImpact: "high" | "medium" | "low";
}

export type VerdictDistribution = Record<VerdictChoice, string[]>;

export interface WithheldVerdict {
  personaKey: string;
  personaName: string;
  reason: WithheldReason;
  detail: string;
}

export interface PanelReport {
  version: "1.0.0";
  generatedAt: string;
  personaCount: number;
  syntheticDisclaimer: string;
  /** Persona names per bucket — never just a percentage. */
  distribution: VerdictDistribution;
  withheld: WithheldVerdict[];
  rankedObjections: ObjectionCluster[];
  sectionHeat: SectionHeatRow[];
  fixes: FixSuggestion[];
  /** Fix suggestions not made because the run reached its credit cap. */
  fixesSkippedAtCap: number;
}

function clusterTokens(text: string): Set<string> {
  return new Set(tokenize(text));
}

export const CLUSTER_JACCARD_THRESHOLD = 0.5;

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const SEVERITY_WEIGHT: Record<ObjectionSeverity, number> = { high: 3, medium: 2, low: 1 };

/** Cluster objections across personas; rank by frequency × severity weight. */
export function clusterObjections(inputs: ObjectionClusterInput[]): ObjectionCluster[] {
  const n = inputs.length;
  if (n === 0) return [];
  const tokens = inputs.map((o) => clusterTokens(o.quote));
  const parent = inputs.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    return r;
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (jaccard(tokens[i]!, tokens[j]!) >= CLUSTER_JACCARD_THRESHOLD) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);

  const out: Array<{ cluster: ObjectionCluster; score: number }> = [];
  for (const idxs of groups.values()) {
    const members = idxs.map((i) => inputs[i]!);
    const rep = [...members].sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || b.quote.length - a.quote.length)[0]!;
    const seen = new Set<string>();
    const interviewQuotes: InterviewTrace[] = [];
    for (const m of members) {
      if (m.interview && !seen.has(m.interview.excerpt)) {
        seen.add(m.interview.excerpt);
        interviewQuotes.push(m.interview);
      }
    }
    out.push({
      cluster: {
        representativeQuote: rep.quote,
        count: members.length,
        personaKeys: [...new Set(members.map((m) => m.personaKey))].sort(),
        personaNames: [...new Set(members.map((m) => m.personaName))].sort(),
        sections: [...new Set(members.map((m) => m.section))].sort(),
        sourceTranscriptIds: [...new Set([...members.flatMap((m) => (m.sourceTranscriptId ? [m.sourceTranscriptId] : [])), ...interviewQuotes.map((q) => q.transcriptId)])].sort(),
        interviewQuotes,
        severity: rep.severity,
      },
      score: members.reduce((s, m) => s + SEVERITY_WEIGHT[m.severity], 0),
    });
  }
  out.sort((a, b) => b.score - a.score || b.cluster.count - a.cluster.count);
  return out.map((o) => o.cluster);
}

/** Per-section rollup across the panel — where attention died. */
export function sectionHeat(timelines: FrictionTimeline[]): SectionHeatRow[] {
  const dwell = new Map<string, number[]>();
  const friction = new Map<string, number>();
  const bounces = new Map<string, number>();
  for (const tl of timelines) {
    for (const s of tl.sections) {
      dwell.set(s.name, [...(dwell.get(s.name) ?? []), s.totalDwellMs]);
      friction.set(s.name, (friction.get(s.name) ?? 0) + s.frictionCount);
    }
    if (tl.outcome === "bounced") {
      const drop = tl.events.find((e) => e.severity === "critical");
      const name = drop?.section ?? tl.sections[tl.sections.length - 1]?.name ?? "(page)";
      bounces.set(name, (bounces.get(name) ?? 0) + 1);
    }
  }
  const rows: SectionHeatRow[] = [];
  for (const [name, vals] of dwell) {
    rows.push({ name, avgDwellMs: vals.reduce((a, b) => a + b, 0) / vals.length, totalFriction: friction.get(name) ?? 0, bounceCount: bounces.get(name) ?? 0, personas: vals.length });
  }
  rows.sort((a, b) => b.totalFriction - a.totalFriction || b.avgDwellMs - a.avgDwellMs);
  return rows;
}

export const FIX_CLUSTER_CAP = 5;
export const FixSchema = z.object({ suggestedFix: z.string(), expectedImpact: z.enum(["high", "medium", "low"]) });
export const FIX_TOOL = { name: "submit_fix", description: "Submit one concrete fix for the page.", schema: FixSchema };
export const FIX_MAX_TOKENS = 300;

async function suggestFixes(clusters: ObjectionCluster[], model: PanelModel, runId: string): Promise<{ fixes: FixSuggestion[]; skipped: number }> {
  const top = clusters.slice(0, FIX_CLUSTER_CAP);
  const fixes: FixSuggestion[] = [];
  for (const [i, cluster] of top.entries()) {
    try {
      const res = await model.structured(runId, {
        purpose: "fix",
        system: "You advise founders on landing-page fixes from SYNTHETIC panel data (directional signals, never certainties). Be concrete and brief.",
        user: [
          `Synthetic customers raised this objection (${cluster.count} mention(s), personas: ${cluster.personaNames.join(", ")}):`,
          `"${cluster.representativeQuote}"`,
          cluster.interviewQuotes.length ? `Real interview words behind it: ${cluster.interviewQuotes.map((q) => `"${q.excerpt}"`).join(" ")}` : "No interview supports it directly (page-only objection).",
          `Sections where it surfaced: ${cluster.sections.join(", ") || "(unknown)"}.`,
          "Suggest ONE concrete fix the founder could make to the page.",
        ].join("\n"),
        tool: FIX_TOOL,
        maxTokens: FIX_MAX_TOKENS,
      });
      fixes.push({ objection: cluster.representativeQuote, ...res.value });
    } catch (err) {
      if (isCapReached(err)) return { fixes, skipped: top.length - i };
      throw err;
    }
  }
  return { fixes, skipped: 0 };
}

export interface AggregateReportArgs {
  outcomes: VerdictOutcome[];
  timelines: FrictionTimeline[];
  /** Fix suggestions need a model; omit to skip them. */
  model?: PanelModel;
  runId?: string;
  now?: Date;
}

export async function aggregateReport(args: AggregateReportArgs): Promise<PanelReport> {
  const distribution: VerdictDistribution = { buy: [], "no-buy": [], maybe: [] };
  const withheld: WithheldVerdict[] = [];
  const inputs: ObjectionClusterInput[] = [];
  const verdicts: PersonaVerdict[] = [];
  for (const o of args.outcomes) {
    if (o.kind === "withheld") {
      withheld.push({ personaKey: o.personaKey, personaName: o.personaName, reason: o.reason, detail: o.detail });
      continue;
    }
    verdicts.push(o.verdict);
    distribution[o.verdict.verdict].push(o.verdict.personaName);
    for (const ob of o.verdict.objections) {
      inputs.push({ quote: ob.quote, section: ob.section, severity: ob.severity, ...(ob.sourceTranscriptId ? { sourceTranscriptId: ob.sourceTranscriptId } : {}), interview: ob.interview, personaKey: o.verdict.personaKey, personaName: o.verdict.personaName });
    }
  }
  for (const b of Object.keys(distribution) as VerdictChoice[]) distribution[b].sort();
  const rankedObjections = clusterObjections(inputs);
  const { fixes, skipped } = args.model && args.runId ? await suggestFixes(rankedObjections, args.model, args.runId) : { fixes: [], skipped: 0 };
  return {
    version: "1.0.0",
    generatedAt: (args.now ?? new Date()).toISOString(),
    personaCount: args.outcomes.length,
    syntheticDisclaimer: SYNTHETIC_DISCLAIMER,
    distribution,
    withheld,
    rankedObjections,
    sectionHeat: sectionHeat(args.timelines),
    fixes,
    fixesSkippedAtCap: skipped,
  };
}

/** Verdicts behind a distribution, for calibration (maybe = 0.5). */
export function distributionVerdicts(d: VerdictDistribution): VerdictChoice[] {
  return [...d.buy.map(() => "buy" as const), ...d["no-buy"].map(() => "no-buy" as const), ...d.maybe.map(() => "maybe" as const)];
}

// ---------------------------------------------------------------------------
// Diff between two runs
// ---------------------------------------------------------------------------

export interface DistributionShift {
  bucket: VerdictChoice;
  before: number;
  after: number;
  /** Personas who were judged in both runs and moved into / out of this bucket. */
  joined: string[];
  left: string[];
}

export interface ObjectionShift {
  quote: string;
  /** Personas raising it out of the personas with a verdict in each run. */
  before: { count: number; of: number };
  after: { count: number; of: number };
  change: "new" | "gone" | "fewer" | "more" | "same";
}

export interface ReportDiff {
  syntheticDisclaimer: string;
  distribution: DistributionShift[];
  objections: ObjectionShift[];
  heat: Array<{ name: string; frictionBefore: number; frictionAfter: number }>;
}

function judged(r: PanelReport): number {
  return r.distribution.buy.length + r.distribution["no-buy"].length + r.distribution.maybe.length;
}

/** What changed from run `a` (before) to run `b` (after). Objections match by token Jaccard. */
export function diffReports(a: PanelReport, b: PanelReport): ReportDiff {
  const buckets: VerdictChoice[] = ["buy", "maybe", "no-buy"];
  const distribution = buckets.map((bucket) => {
    const before = new Set(a.distribution[bucket]);
    const after = new Set(b.distribution[bucket]);
    return { bucket, before: before.size, after: after.size, joined: [...after].filter((n) => !before.has(n)).sort(), left: [...before].filter((n) => !after.has(n)).sort() };
  });
  const ofA = judged(a);
  const ofB = judged(b);
  const used = new Set<number>();
  const objections: ObjectionShift[] = [];
  for (const ca of a.rankedObjections) {
    const ta = clusterTokens(ca.representativeQuote);
    let match = -1;
    let bestScore = 0;
    b.rankedObjections.forEach((cb, j) => {
      if (used.has(j)) return;
      const s = jaccard(ta, clusterTokens(cb.representativeQuote));
      if (s >= CLUSTER_JACCARD_THRESHOLD && s > bestScore) {
        bestScore = s;
        match = j;
      }
    });
    const before = { count: ca.personaKeys.length, of: ofA };
    if (match < 0) {
      objections.push({ quote: ca.representativeQuote, before, after: { count: 0, of: ofB }, change: "gone" });
      continue;
    }
    used.add(match);
    const cb = b.rankedObjections[match]!;
    const after = { count: cb.personaKeys.length, of: ofB };
    const ra = before.of ? before.count / before.of : 0;
    const rb = after.of ? after.count / after.of : 0;
    objections.push({ quote: ca.representativeQuote, before, after, change: rb < ra ? "fewer" : rb > ra ? "more" : "same" });
  }
  b.rankedObjections.forEach((cb, j) => {
    if (!used.has(j)) objections.push({ quote: cb.representativeQuote, before: { count: 0, of: ofA }, after: { count: cb.personaKeys.length, of: ofB }, change: "new" });
  });
  const names = [...new Set([...a.sectionHeat.map((h) => h.name), ...b.sectionHeat.map((h) => h.name)])];
  const heat = names.map((name) => ({ name, frictionBefore: a.sectionHeat.find((h) => h.name === name)?.totalFriction ?? 0, frictionAfter: b.sectionHeat.find((h) => h.name === name)?.totalFriction ?? 0 }));
  return { syntheticDisclaimer: SYNTHETIC_DISCLAIMER, distribution, objections, heat };
}
