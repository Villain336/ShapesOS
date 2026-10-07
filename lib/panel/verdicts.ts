// ShapesOS — Phase 19B (WS=panel): per-persona verdicts.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// Ported from the prototype's src/reporting/verdicts.ts. A verdict is READ
// OFF the persona's behaviour, think-aloud and memory — never asked as "would
// you buy this?" — and is never a bare number: it ships with ranked
// objections whose quotes trace to evidence. Rules enforced in code:
//   * NO CALIBRATION → NO VERDICT. A persona without an interview behind it
//     (no source transcript, or none of its transcripts in the memory
//     stream) gets no verdict: NoCalibrationError. The prototype only said
//     this in its README;
//   * an incomplete walk (cap-stopped / failed) gets no verdict either — the
//     report says why (withheld), it never guesses;
//   * a bounce is never a buy (clamped to no-buy, noted in the rationale);
//   * every objection quote must trace (4+ shared content words) to a step or
//     to the persona's OWN interviews; invented quotes are dropped and
//     counted. Each kept objection also carries the interview words behind it
//     (traceToInterviews) or says that the interviews don't support it.
// Changed: structured output; evidence from the persona's own transcripts
// only (the prototype's global retrieval could cite another persona's
// interview); the verdict is stored as a "verdict" node for this run/persona.

import { z } from "zod";
import type { MemoryStore } from "./memory";
import type { PanelModel } from "./model";
import { isCalibratedSpec, type ObjectionSeverity, type PersonaSpec } from "./persona";
import type { FrictionTimeline } from "./timeline";
import { filterTraceableQuotes, traceToInterviews, type EvidenceItem, type InterviewTrace } from "./trace";
import { COMPLETE_OUTCOMES, type WalkthroughResult } from "./walk";

export type VerdictChoice = "buy" | "no-buy" | "maybe";

export interface VerdictObjection {
  quote: string;
  section: string;
  severity: ObjectionSeverity;
  sourceTranscriptId?: string;
  /** The interview words behind the objection; null = the interviews don't support it. */
  interview: InterviewTrace | null;
}

export interface PersonaVerdict {
  personaKey: string;
  personaName: string;
  verdict: VerdictChoice;
  /** 0–1. */
  confidence: number;
  rationale: string;
  /** Ranked by severity; every quote traceable. */
  objections: VerdictObjection[];
  whatWouldChangeMind: string[];
  behaviorSummary: string;
  /** Quotes the model offered that traced to nothing (dropped). */
  droppedQuotes: number;
  /** A bounce read as a buy was clamped to no-buy. */
  clamped: boolean;
}

export type WithheldReason = "no_calibration" | "incomplete_walk";

export class NoCalibrationError extends Error {
  constructor(readonly personaName: string) {
    super(`No verdict for ${personaName}: the persona isn't calibrated on any interview. No calibration data → no verdicts.`);
    this.name = "NoCalibrationError";
  }
}

export const VerdictSchema = z.object({
  verdict: z.enum(["buy", "no-buy", "maybe"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  objections: z.array(z.object({ quote: z.string(), section: z.string(), severity: z.enum(["low", "medium", "high"]) })),
  whatWouldChangeMind: z.array(z.string()),
  behaviorSummary: z.string(),
});

export const VERDICT_TOOL = { name: "submit_verdict", description: "Submit the verdict read off the evidence.", schema: VerdictSchema };
export const VERDICT_MAX_TOKENS = 1200;

export interface RenderVerdictArgs {
  model: PanelModel;
  store: MemoryStore;
  personaSpec: PersonaSpec;
  result: WalkthroughResult;
  timeline: FrictionTimeline;
  runId: string;
}

/** Is the persona calibrated: a source transcript that is actually in the memory stream? */
export async function personaCalibrated(store: MemoryStore, spec: PersonaSpec): Promise<boolean> {
  if (!isCalibratedSpec(spec)) return false;
  for (const id of spec.sourceTranscriptIds) {
    if ((await store.transcriptNodes(id, ["interview"])).length > 0) return true;
  }
  return false;
}

/** Steps + this persona's own interview / reflection memory. */
async function collectEvidence(args: RenderVerdictArgs): Promise<EvidenceItem[]> {
  const evidence: EvidenceItem[] = [];
  for (const step of args.result.steps) {
    const section = step.observation.sectionMeta?.heading ?? step.observation.sectionMeta?.sectionId ?? "(page)";
    if (step.thinkAloud.trim()) evidence.push({ text: step.thinkAloud, section });
    const obsText = [step.observation.textExcerpt, step.observation.detail].filter(Boolean).join(" ");
    if (obsText.trim()) evidence.push({ text: obsText, section });
  }
  // k per transcript, so each interview contributes (no starvation).
  const mem = await args.store.retrieve("objections doubts concerns price trust decision buy", {
    k: 4,
    perTranscript: true,
    kinds: ["interview", "reflection"],
    transcriptIds: args.personaSpec.sourceTranscriptIds,
    weights: { recency: 1, relevance: 2, importance: 1.5 },
  });
  for (const s of mem) evidence.push({ text: s.node.content, section: "(memory)", ...(s.node.transcriptId ? { sourceTranscriptId: s.node.transcriptId } : {}) });
  return evidence;
}

function formatTimeline(timeline: FrictionTimeline): string {
  const lines = timeline.events
    .filter((e) => e.severity === "friction" || e.severity === "critical")
    .map((e) => `- [${e.severity}] ${e.section ?? "(page)"}: ${e.summary}${e.detail ? ` — ${e.detail.slice(0, 160)}` : ""}`);
  const drop = timeline.events.find((e) => e.severity === "critical");
  return [`Outcome: ${timeline.outcome}`, drop ? `Drop-off: ${drop.summary}` : "Drop-off: none", ...lines].join("\n");
}

const SEVERITY_RANK: Record<ObjectionSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Read one persona's verdict (one model call). Throws NoCalibrationError for an uncalibrated persona. */
export async function renderVerdict(args: RenderVerdictArgs): Promise<PersonaVerdict> {
  const { model, store, personaSpec, timeline, runId, result } = args;
  if (!(await personaCalibrated(store, personaSpec))) throw new NoCalibrationError(personaSpec.identity.name);
  const evidence = await collectEvidence(args);
  const id = personaSpec.identity;
  const system = [
    `You read a verdict OFF observed behaviour for a synthetic customer persona: ${id.name}, ${id.role}.`,
    "This persona is LABELLED SYNTHETIC. You read evidence and report what it shows.",
    "RULES:",
    "- Never answer 'would you buy this?' cold. Derive the verdict from what they did, what they said thinking aloud, where friction hit, and what their interviews say.",
    "- Every objection quote MUST be copied verbatim from the evidence. Inventing quotes is forbidden.",
    "- Show disagreement honestly: if the behaviour is mixed, say 'maybe' and explain the tension.",
  ].join("\n");
  const user = [
    `[Persona] ${id.name}, ${id.role}. Goals: ${personaSpec.goals.join("; ")}.`,
    `Budget: ${personaSpec.budget.currency} ${personaSpec.budget.monthlyMax}/month${personaSpec.budget.hardCap ? " (hard cap)" : ""}. Skepticism: ${personaSpec.skepticism}.`,
    "",
    "[Observed behaviour + friction]",
    formatTimeline(timeline),
    "",
    "[Think-aloud, observations, and interview memory]",
    evidence.map((e, i) => `[E${i} | ${e.section}${e.sourceTranscriptId ? ` | interview ${e.sourceTranscriptId}` : ""}] ${e.text.slice(0, 500)}`).join("\n"),
    "",
    "[Known objections from calibration]",
    personaSpec.knownObjections.length ? personaSpec.knownObjections.map((o) => `- [${o.severity}] ${o.text}`).join("\n") : "(none)",
    "",
    "Read this persona's verdict off the evidence above.",
  ].join("\n");
  const res = await model.structured(runId, { purpose: "verdict", system, user, tool: VERDICT_TOOL, maxTokens: VERDICT_MAX_TOKENS });
  const parsed = res.value;

  let verdict: VerdictChoice = parsed.verdict;
  let rationale = parsed.rationale;
  let clamped = false;
  if (result.outcome === "bounced" && verdict === "buy") {
    verdict = "no-buy";
    clamped = true;
    rationale = `${rationale} [Honesty clamp: the walk ended in a bounce, so a buy verdict is impossible; clamped to no-buy.]`;
  }

  let dropped = 0;
  const traced = filterTraceableQuotes(
    parsed.objections.filter((o) => o.quote.trim()),
    evidence,
    () => (dropped += 1),
  );
  const chunks: Array<{ transcriptId: string; content: string }> = [];
  for (const tid of personaSpec.sourceTranscriptIds) {
    for (const n of await store.transcriptNodes(tid, ["interview"])) chunks.push({ transcriptId: tid, content: n.content });
  }
  const objections: VerdictObjection[] = traced
    .map((o) => ({ ...o, interview: traceToInterviews(o.quote, chunks) }))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const final: PersonaVerdict = {
    personaKey: result.personaKey,
    personaName: id.name,
    verdict,
    confidence: parsed.confidence,
    rationale,
    objections,
    whatWouldChangeMind: parsed.whatWouldChangeMind,
    behaviorSummary: parsed.behaviorSummary,
    droppedQuotes: dropped,
    clamped,
  };
  await store.addNode({ id: `${runId}:${result.personaKey}:verdict`, kind: "verdict", runId, personaKey: result.personaKey, content: JSON.stringify({ verdict, confidence: final.confidence, rationale }), importance: 0.9, chunkIndex: 0 });
  return final;
}

export type VerdictOutcome = { kind: "verdict"; verdict: PersonaVerdict } | { kind: "withheld"; personaKey: string; personaName: string; reason: WithheldReason; detail: string };

/** The verdict, or why there is none (no calibration, incomplete walk). Cap stops and model errors propagate. */
export async function verdictOrWithheld(args: RenderVerdictArgs): Promise<VerdictOutcome> {
  const name = args.personaSpec.identity.name;
  if (!COMPLETE_OUTCOMES.includes(args.result.outcome)) {
    return { kind: "withheld", personaKey: args.result.personaKey, personaName: name, reason: "incomplete_walk", detail: args.result.stopReason ?? `The walk ended ${args.result.outcome}.` };
  }
  try {
    return { kind: "verdict", verdict: await renderVerdict(args) };
  } catch (err) {
    if (err instanceof NoCalibrationError) return { kind: "withheld", personaKey: args.result.personaKey, personaName: name, reason: "no_calibration", detail: err.message };
    throw err;
  }
}
