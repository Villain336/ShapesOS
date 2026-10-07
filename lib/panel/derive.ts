// ShapesOS — Phase 19B (WS=panel): persona derivation from interviews.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// Ported from the prototype's src/persona/derive.ts: pull a transcript's
// evidence, ask the model for a PersonaSpec grounded in it, validate it,
// optionally compose fragments. The founder then edits or vetoes the spec
// (applyFounderEdits lives in ./persona.ts).
//
// What changed versus the prototype:
//   * evidence is retrieved SCOPED to the transcript (its own interview and
//     reflection nodes). The prototype took the global top 3k nodes across
//     every transcript and filtered to this one afterwards, so with several
//     interviews a persona could get little or none of its own evidence;
//   * structured output (a submit_persona tool) instead of JSON mode;
//   * citations are ENFORCED in code: the spec cites its transcript, and every
//     known objection must trace to words in that interview — an objection
//     the interview does not support is dropped (and reported), never kept.

import { z } from "zod";
import { mergeFragments, assertValidPersonaSpec, PersonaSpecSchema, type PersonaFragment, type PersonaSpec } from "./persona";
import type { MemoryStore } from "./memory";
import type { PanelModel } from "./model";
import { traceToInterviews } from "./trace";

export interface DerivePersonaSpecOptions {
  model: PanelModel;
  store: MemoryStore;
  /** Transcript the persona is calibrated on. Objections cite this id. */
  transcriptId: string;
  fragments?: PersonaFragment[];
  /** Ledger run the call is reserved on. */
  runId: string;
  /** Max verbatim evidence chunks fed to the model. Default 12. */
  evidenceNodes?: number;
}

export interface DerivedPersona {
  spec: PersonaSpec;
  /** Objections the model proposed that the interview does not support (dropped). */
  droppedObjections: string[];
  /** Evidence chunks the model saw. */
  evidenceCount: number;
}

const DERIVE_SYSTEM = [
  "You derive a customer persona spec from interview evidence.",
  "RULES:",
  "- Ground EVERYTHING in the evidence chunks. Do not invent objections, budgets, or beliefs the interviewee never voiced.",
  '- Every knownObjection carries "sourceTranscriptId" set to the transcript id you were given, and its text uses the interviewee\'s own words.',
  "- Infer skepticism from tone: dismissive of vendor claims, past burns, ROI demands → high; open and trusting → low.",
  "- Prefer the interviewee's own words for goals, objections, and beliefs.",
  "- If the evidence is thin on a field, make a conservative neutral choice (short arrays, skepticism 0.5) — never fabricate.",
  "- budget.currency is a 3-letter ISO code (e.g. USD); every 0-1 field stays within 0 and 1.",
].join("\n");

export const DERIVE_TOOL = {
  name: "submit_persona",
  description: "Submit the persona spec derived from the interview evidence.",
  schema: PersonaSpecSchema as z.ZodType<PersonaSpec>,
};

export const DERIVE_MAX_TOKENS = 2500;

/** Derive a spec from one transcript's own evidence, enforce citations, compose fragments. */
export async function derivePersonaSpec(options: DerivePersonaSpecOptions): Promise<DerivedPersona> {
  const { model, store, transcriptId, fragments = [], runId, evidenceNodes = 12 } = options;
  const transcript = await store.getTranscript(transcriptId);
  if (!transcript) throw new Error(`No transcript with id ${JSON.stringify(transcriptId)}`);

  // Scoped retrieval: this transcript's interview chunks and reflections only.
  const scored = await store.retrieve("persona identity goals occupation budget skepticism objections beliefs behaviors preferences price trust competitor", {
    k: evidenceNodes,
    kinds: ["interview", "reflection"],
    transcriptIds: [transcriptId],
    weights: { recency: 0.5, relevance: 1.5, importance: 1.5 },
  });
  const interview = scored.filter((s) => s.node.kind === "interview").sort((a, b) => a.node.chunkIndex - b.node.chunkIndex);
  const reflections = scored.filter((s) => s.node.kind === "reflection");
  const evidenceText = [
    ...interview.map((s) => `[chunk ${s.node.chunkIndex}]\n${s.node.content}`),
    ...reflections.map((s) => `[reflection ${s.node.lens ?? ""}] ${s.node.content}`),
  ].join("\n\n");

  const res = await model.structured(runId, {
    purpose: "derive",
    system: DERIVE_SYSTEM,
    user: [
      `TRANSCRIPT ID: ${transcriptId}`,
      `INTERVIEWEE: ${transcript.interviewee ?? "unknown"}`,
      "",
      "EVIDENCE CHUNKS (verbatim, in order):",
      evidenceText.length > 0 ? evidenceText : "(no interview chunks retrieved)",
      "",
      "Derive the persona spec now.",
    ].join("\n"),
    tool: DERIVE_TOOL,
    maxTokens: DERIVE_MAX_TOKENS,
  });

  // Citations, enforced: every objection must trace to this interview's words.
  const chunks = (await store.transcriptNodes(transcriptId, ["interview"])).map((n) => ({ transcriptId, content: n.content }));
  const fullText = chunks.length > 0 ? chunks : [{ transcriptId, content: transcript.text }];
  const droppedObjections: string[] = [];
  const spec: PersonaSpec = {
    ...res.value,
    knownObjections: res.value.knownObjections.flatMap((o) => {
      if (!traceToInterviews(o.text, fullText)) {
        droppedObjections.push(o.text);
        return [];
      }
      return [{ ...o, sourceTranscriptId: transcriptId }];
    }),
    // The model only saw this transcript, so it is the only citation.
    sourceTranscriptIds: [transcriptId],
  };
  assertValidPersonaSpec(spec);
  const merged = fragments.length > 0 ? mergeFragments(spec, fragments) : spec;
  assertValidPersonaSpec(merged);
  return { spec: merged, droppedObjections, evidenceCount: interview.length + reflections.length };
}
