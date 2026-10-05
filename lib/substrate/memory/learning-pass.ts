// Marketr — Phase 13B nightly learning pass ("sleep").
//
// EXTENDS the Growth Memory consolidation job
// (lib/substrate/memory/consolidate.ts) — never a second memory system
// (spec §9, DATA-MODEL.md). This module is invoked as step 5 of
// executeConsolidationRun, and is also what powers the dedicated cron route
// /api/cron/learning-consolidate.
//
// Per workspace, once per night:
//   1. Skip if learning is paused (pref:learning_paused via getLearningPaused).
//   2. Skip if a learning pass already ran tonight (run-row bookkeeping).
//   3. Gather recent agent_call episodes + feedback (edit-diffs weighted
//      highest — the richest signal per spec §1).
//   4. One LLM pass (background workload) → durable lessons, plus optional
//      intelligence-layer proposals.
//   5. Lessons → memory_learnings (source="consolidation", confidence in
//      metricDelta.confidence); semantic dedupe against active learnings
//      (skip new dupes; retire later dups via invalidatedAt — never delete);
//      low-confidence learnings untouched for N days are retired.
//   6. Intelligence write-back arrives ONLY as reviewable diffs:
//      - brand-voice patterns → BrandVoiceProfile.pendingUpdates
//        (pinnedByUser=true ⇒ read-only: skip entirely);
//      - knowledge facts → CompanyKnowledge rows carrying
//        body.needsReview=true (proposals, user approves in the UI);
//      - style-rule candidates → StyleRule rows with active=false,
//        source="consolidation".
//      Pinned elements (voice profile, knowledge rows, rules) are READ-ONLY
//      to the learner — never written, never superseded.
//
// Cost guards: exactly one LLM call per workspace per pass; per-night
// dedupe via the run row; MAX_WORKSPACES_PER_RUN env-tunable cap is
// enforced by the cron route; token usage is logged and stored on the run
// row. If no LLM provider is live (mock fallback), the LLM pass is skipped
// LOUDLY — mock copy must never become durable "knowledge".

import { withWorkerScope } from "./consolidate";
import { getLearningPaused } from "./preferences";
import { recordLearning, invalidateLearning } from "./write";
import { scrubJson, scrubSecrets } from "./scrub";
import {
  getLlmProviderFor,
  WORKLOAD_MAX_TOKENS,
  type LlmWorkload,
} from "@/lib/llm/router";
import type { MemoryLearningResult } from "./types";

// ---------------------------------------------------------------------------
// Tuning (env-overridable; read at call time so tests/long-lived servers
// see current config — same rule as lib/llm/router.ts).
// ---------------------------------------------------------------------------

/** Max workspaces a single cron invocation processes. */
export const DEFAULT_MAX_WORKSPACES_PER_RUN = 50;
export function maxWorkspacesPerRun(): number {
  const raw = parseInt(
    (process.env.LEARNING_CONSOLIDATE_MAX_WORKSPACES ?? "").trim(),
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_WORKSPACES_PER_RUN;
}

/** Episode lookback window for the learning pass. */
export function learningLookbackDays(): number {
  const raw = parseInt((process.env.LEARNING_LOOKBACK_DAYS ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}

/** Max episodes fed to one prompt (bounded prompt size = bounded cost). */
export function learningMaxEpisodes(): number {
  const raw = parseInt((process.env.LEARNING_MAX_EPISODES ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 50;
}

/** Normalized-token similarity ≥ this ⇒ duplicate learning. */
export function learningSimilarityThreshold(): number {
  const raw = parseFloat(
    (process.env.LEARNING_SIMILARITY_THRESHOLD ?? "").trim(),
  );
  return Number.isFinite(raw) && raw > 0 && raw <= 1
    ? raw
    : 0.75;
}

/** Learnings with confidence below this, untouched for decayDays, retire. */
export function learningDecayConfidence(): number {
  const raw = parseFloat((process.env.LEARNING_DECAY_CONFIDENCE ?? "").trim());
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
}

/** Days a low-confidence learning must sit untouched before retirement. */
export function learningDecayDays(): number {
  const raw = parseInt((process.env.LEARNING_DECAY_DAYS ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests).
// ---------------------------------------------------------------------------

/** Normalize a lesson/knowledge title for similarity comparison. */
export function normalizeLearningText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(text.split(" ").filter((t) => t.length > 1));
}

function bigramSet(text: string): Set<string> {
  const toks = text.split(" ").filter((t) => t.length > 0);
  const out = new Set<string>();
  for (let i = 0; i < toks.length - 1; i++) out.add(`${toks[i]} ${toks[i + 1]}`);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Semantic-ish similarity between two lesson texts (0..1).
 * Exact normalized match ⇒ 1; substring ⇒ ≥0.8; otherwise the best of
 * unigram and bigram Jaccard over normalized tokens. Deterministic and
 * embedding-independent — usable in tests without the local model cache.
 */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeLearningText(a);
  const nb = normalizeLearningText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  let score = Math.max(
    jaccard(tokenSet(na), tokenSet(nb)),
    jaccard(bigramSet(na), bigramSet(nb)),
  );
  if (na.includes(nb) || nb.includes(na)) score = Math.max(score, 0.8);
  return score;
}

// ---------------------------------------------------------------------------
// LLM output contract.
// ---------------------------------------------------------------------------

export interface LearningPassLesson {
  /** Durable lesson text ("always lead with the number"). */
  hypothesis: string;
  /** 0..1 */
  confidence: number;
  /** what the lesson describes: something that worked / something that failed */
  result?: MemoryLearningResult;
  /** episode ids the lesson cites */
  evidence?: string[];
}

export interface LearningPassVoiceProposal {
  dimensions: Record<string, unknown>;
  rationale: string;
}

export interface LearningPassKnowledge {
  kind:
    | "product"
    | "pricing"
    | "audience"
    | "competitor"
    | "pillar"
    | "proof"
    | "positioning"
    | "other";
  title: string;
  /** Kind-shaped body per DATA-MODEL.md contract (needsReview added on write). */
  body: Record<string, unknown>;
  confidence: number;
}

export interface LearningPassStyleRule {
  kind: "ban" | "require" | "disclaimer" | "tone";
  pattern: string;
  replacement?: string;
  severity: "block" | "flag";
}

export interface LearningPassOutput {
  lessons: LearningPassLesson[];
  voiceProposal: LearningPassVoiceProposal | null;
  knowledge: LearningPassKnowledge[];
  styleRules: LearningPassStyleRule[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse the LLM's JSON (fence-wrapped or bare). Returns null on malformed
 * output — the pass then records the lesson-less state rather than writing
 * garbage (honest-failure rule).
 */
export function parseLearningPassOutput(text: string): LearningPassOutput | null {
  let payload = text.trim();
  const fence = payload.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) payload = fence[1].trim();
  const start = payload.indexOf("{");
  const end = payload.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const lessons: LearningPassLesson[] = [];
  if (Array.isArray(parsed.lessons)) {
    for (const l of parsed.lessons.slice(0, 25)) {
      if (!isRecord(l)) continue;
      const hypothesis = typeof l.hypothesis === "string" ? l.hypothesis.trim() : "";
      if (hypothesis.length < 8) continue;
      const confidence =
        typeof l.confidence === "number" && l.confidence >= 0 && l.confidence <= 1
          ? l.confidence
          : 0.5;
      const result: MemoryLearningResult =
        l.result === "failed" || l.result === "inconclusive" ? l.result : "worked";
      const evidence = Array.isArray(l.evidence)
        ? l.evidence.filter((e): e is string => typeof e === "string").slice(0, 10)
        : [];
      lessons.push({ hypothesis, confidence, result, evidence });
    }
  }
  const voiceProposal: LearningPassVoiceProposal | null =
    isRecord(parsed.voiceProposal) &&
    isRecord(parsed.voiceProposal.dimensions) &&
    typeof parsed.voiceProposal.rationale === "string" &&
    parsed.voiceProposal.rationale.trim().length > 0
      ? {
          dimensions: parsed.voiceProposal.dimensions,
          rationale: parsed.voiceProposal.rationale.trim().slice(0, 2000),
        }
      : null;
  const knowledge: LearningPassKnowledge[] = [];
  const kinds = new Set([
    "product",
    "pricing",
    "audience",
    "competitor",
    "pillar",
    "proof",
    "positioning",
    "other",
  ]);
  if (Array.isArray(parsed.knowledge)) {
    for (const k of parsed.knowledge.slice(0, 15)) {
      if (!isRecord(k)) continue;
      const kind = typeof k.kind === "string" && kinds.has(k.kind) ? k.kind : null;
      const title = typeof k.title === "string" ? k.title.trim() : "";
      if (!kind || title.length < 3 || !isRecord(k.body)) continue;
      const confidence =
        typeof k.confidence === "number" && k.confidence >= 0 && k.confidence <= 1
          ? k.confidence
          : 0.5;
      knowledge.push({
        kind: kind as LearningPassKnowledge["kind"],
        title: title.slice(0, 200),
        body: k.body,
        confidence,
      });
    }
  }
  const styleRules: LearningPassStyleRule[] = [];
  const ruleKinds = new Set(["ban", "require", "disclaimer", "tone"]);
  const severities = new Set(["block", "flag"]);
  if (Array.isArray(parsed.styleRules)) {
    for (const r of parsed.styleRules.slice(0, 15)) {
      if (!isRecord(r)) continue;
      const kind = typeof r.kind === "string" && ruleKinds.has(r.kind) ? r.kind : null;
      const pattern = typeof r.pattern === "string" ? r.pattern.trim() : "";
      const severity =
        typeof r.severity === "string" && severities.has(r.severity)
          ? r.severity
          : "flag";
      if (!kind || pattern.length < 2) continue;
      styleRules.push({
        kind: kind as LearningPassStyleRule["kind"],
        pattern: pattern.slice(0, 500),
        replacement:
          typeof r.replacement === "string" ? r.replacement.slice(0, 500) : undefined,
        severity: severity as LearningPassStyleRule["severity"],
      });
    }
  }
  return { lessons, voiceProposal, knowledge, styleRules };
}

// ---------------------------------------------------------------------------
// Prompt.
// ---------------------------------------------------------------------------

interface EpisodeMaterial {
  id: string;
  actor: string;
  summary: string;
  feedback: Array<{ kind: string; before?: string; after?: string; reason?: string }>;
  hasEditDiff: boolean;
}

export function buildLearningPrompt(
  workspaceId: string,
  materials: EpisodeMaterial[],
  dateLabel: string,
): string {
  const lines: string[] = [];
  lines.push(
    `You are the nightly consolidation pass ("sleep") for a marketing AI workspace (${workspaceId}, ${dateLabel}).`,
    ``,
    `Below are recent agent interactions (episodes) and user feedback signals. EDIT-DIFFS ARE THE RICHEST SIGNAL: when the user edited an agent draft (before → after), the diff is the lesson — what the user removed, added, or rephrased reveals what "good" means for this workspace. Explicit thumbs-down and regeneration requests are the next-richest signal.`,
    ``,
    `Extract DURABLE lessons — rules that will still be true next month ("always lead with the number; cut fluffy intros"), not one-off facts. Discard noise: one-off typos, context-free praise, episodes with no clear pattern.`,
    ``,
    `Also watch for:`,
    `- BRAND-VOICE patterns: consistent tone/vocabulary shifts in edit-diffs (propose a voiceProposal with partial dimensions: vocabulary[], rhythm, formality, pov, humor, doExamples[], dontExamples[] + rationale).`,
    `- KNOWLEDGE facts worth keeping: new product/pricing/audience/competitor/pillar/proof/positioning mentions (propose knowledge entries).`,
    `- STYLE-RULE candidates: phrases the user repeatedly edits OUT (propose a "ban" rule), or disclaimers/tone they repeatedly add (propose "require"/"tone" rules).`,
    ``,
    `Respond with STRICT JSON only (no markdown fences, no commentary):`,
    JSON.stringify(
      {
        lessons: [
          {
            hypothesis: "durable lesson text",
            confidence: 0.8,
            result: "worked",
            evidence: ["<episode id>"],
          },
        ],
        voiceProposal: {
          dimensions: { vocabulary: ["…"], formality: "…" },
          rationale: "why this proposal follows from the edits",
        },
        knowledge: [
          {
            kind: "product|pricing|audience|competitor|pillar|proof|positioning|other",
            title: "…",
            body: { summary: "…", features: ["…"] },
            confidence: 0.7,
          },
        ],
        styleRules: [
          {
            kind: "ban|require|disclaimer|tone",
            pattern: "…",
            replacement: "…",
            severity: "block|flag",
          },
        ],
      },
      null,
      2,
    ),
    `Set voiceProposal to null when no voice pattern is visible. Empty arrays when nothing qualifies. Cap: 25 lessons, 15 knowledge, 15 rules.`,
    ``,
    `EPISODES (edit-diff episodes first):`,
  );
  const ordered = [...materials].sort(
    (a, b) => Number(b.hasEditDiff) - Number(a.hasEditDiff),
  );
  for (const m of ordered) {
    lines.push(`- [${m.id}] ${m.actor}: ${m.summary.slice(0, 600)}`);
    for (const f of m.feedback.slice(0, 4)) {
      if (f.kind === "edit_diff" && f.before && f.after) {
        lines.push(
          `    EDIT-DIFF before: "${f.before.slice(0, 400)}" → after: "${f.after.slice(0, 400)}"`,
        );
      } else {
        lines.push(`    feedback(${f.kind})${f.reason ? `: ${f.reason.slice(0, 200)}` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

export interface LearningPassUsage {
  model: string;
  promptChars: number;
  /** chars/4 estimator — providers don't expose token counts here */
  estInputTokens: number;
  estOutputTokens: number;
}

export interface LearningPassReport {
  status:
    | "ran"
    | "skipped_paused"
    | "skipped_already_ran"
    | "skipped_no_material"
    | "skipped_no_llm"
    | "failed";
  learningsExtracted: number;
  learningsSkippedDup: number;
  learningsDecayed: number;
  voiceProposed: number;
  knowledgeProposed: number;
  styleRulesProposed: number;
  llmUsage: LearningPassUsage | null;
  errors: string[];
}

export interface LearningPassOptions {
  /** LLM call; defaults to the background workload provider. Injected in tests. */
  llm?: (prompt: string) => Promise<string>;
  /** Force the model label (defaults to the resolved background model). */
  modelLabel?: string;
  lookbackDays?: number;
  maxEpisodes?: number;
  similarityThreshold?: number;
  decayDays?: number;
  decayConfidence?: number;
}

function emptyReport(status: LearningPassReport["status"]): LearningPassReport {
  return {
    status,
    learningsExtracted: 0,
    learningsSkippedDup: 0,
    learningsDecayed: 0,
    voiceProposed: 0,
    knowledgeProposed: 0,
    styleRulesProposed: 0,
    llmUsage: null,
    errors: [],
  };
}

/** Default LLM: the background workload (digests, decay checks) — cheap models. */
async function defaultLlmGenerate(
  prompt: string,
  maxTokens: number,
  workspaceId?: string,
): Promise<{ text: string; model: string; live: boolean }> {
  // Phase 15: the workspace's own model key when it has one; metered by tokens.
  const provider = workspaceId
    ? await (await import("@/lib/llm/workspace")).getLlmProviderForWorkspace("background", { workspaceId })
    : getLlmProviderFor("background" as LlmWorkload);
  if (!provider.isLive) {
    return { text: "", model: provider.name, live: false };
  }
  const text = await provider.generate(prompt, { maxTokens });
  return { text, model: provider.name, live: true };
}

// ---------------------------------------------------------------------------
// Bookkeeping: one LLM pass per workspace per night.
// ---------------------------------------------------------------------------

/** UTC start of the current day. */
export function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function readLearningPassBookkeeping(errorJson: string | null): { ran: boolean; at?: string } {
  if (!errorJson) return { ran: false };
  try {
    const parsed = JSON.parse(errorJson) as {
      learningPass?: { status?: string; at?: string };
    };
    if (parsed?.learningPass?.status === "ran") {
      return { ran: true, at: parsed.learningPass.at };
    }
  } catch {
    /* ignore malformed bookkeeping */
  }
  return { ran: false };
}

async function alreadyRanTonight(workspaceId: string): Promise<boolean> {
  return withWorkerScope(workspaceId, async (tx) => {
    const runs = await tx.memoryConsolidationRun.findMany({
      where: {
        workspaceId,
        startedAt: { gte: startOfTodayUtc() },
        status: { in: ["succeeded", "completed_with_errors"] },
      },
      orderBy: { startedAt: "desc" },
      take: 5,
      select: { error: true },
    });
    return runs.some((r) => readLearningPassBookkeeping(r.error).ran);
  });
}

// ---------------------------------------------------------------------------
// Material gathering.
// ---------------------------------------------------------------------------

async function gatherMaterials(
  workspaceId: string,
  lookbackDays: number,
  maxEpisodes: number,
): Promise<EpisodeMaterial[]> {
  const since = new Date(Date.now() - lookbackDays * 86400_000);
  return withWorkerScope(workspaceId, async (tx) => {
    const episodes = await tx.memoryEpisode.findMany({
      where: {
        workspaceId,
        episodeType: "agent_call",
        startedAt: { gte: since },
      },
      orderBy: { startedAt: "desc" },
      take: maxEpisodes,
      select: {
        id: true,
        actor: true,
        summary: true,
        feedback: {
          select: { kind: true, signal: true },
          orderBy: { createdAt: "desc" },
          take: 6,
        },
      },
    });
    return episodes.map((ep) => {
      const feedback = ep.feedback.map((f) => {
        const signal = scrubJson((f.signal ?? {}) as Record<string, unknown>).value as Record<
          string,
          unknown
        >;
        return {
          kind: f.kind,
          before: typeof signal.before === "string" ? signal.before : undefined,
          after: typeof signal.after === "string" ? signal.after : undefined,
          reason: typeof signal.reason === "string" ? signal.reason : undefined,
        };
      });
      return {
        id: ep.id,
        actor: ep.actor,
        summary: ep.summary,
        feedback,
        hasEditDiff: feedback.some((f) => f.kind === "edit_diff"),
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Application.
// ---------------------------------------------------------------------------

/** Active (non-invalidated) consolidation-source learnings. */
async function activeLearnings(
  workspaceId: string,
): Promise<Array<{ id: string; hypothesis: string; observedAt: Date }>> {
  return withWorkerScope(workspaceId, async (tx) =>
    tx.memoryLearning.findMany({
      where: { workspaceId, source: "consolidation", invalidatedAt: null },
      orderBy: { observedAt: "asc" },
      take: 500,
      select: { id: true, hypothesis: true, observedAt: true },
    }),
  );
}

/** Record lessons, skipping semantic duplicates of active learnings. */
async function applyLessons(
  workspaceId: string,
  parsed: LearningPassOutput,
  modelLabel: string,
  dateLabel: string,
  threshold: number,
  report: LearningPassReport,
): Promise<void> {
  const active = await activeLearnings(workspaceId);
  for (const lesson of parsed.lessons) {
    const scrubbed = scrubJson({ hypothesis: lesson.hypothesis }).value as {
      hypothesis: string;
    };
    const hypothesis = scrubbed.hypothesis.slice(0, 2000);
    const isDup = active.some(
      (a) => textSimilarity(a.hypothesis, hypothesis) >= threshold,
    );
    if (isDup) {
      report.learningsSkippedDup++;
      continue;
    }
    try {
      const { id } = await recordLearning(workspaceId, {
        hypothesis,
        action: `learning pass ${dateLabel} (LLM ${modelLabel})`,
        result: lesson.result ?? "worked",
        metricDelta: { confidence: lesson.confidence },
        contextRefs: {
          sourceEpisodeIds: lesson.evidence ?? [],
          origin: "agent_inferred",
        },
        source: "consolidation",
        sourceEpisodeId: lesson.evidence?.[0] ?? null,
      });
      active.push({ id, hypothesis, observedAt: new Date() });
      report.learningsExtracted++;
    } catch (err) {
      report.errors.push(
        `lesson "${hypothesis.slice(0, 80)}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Retire later-written near-duplicates among active learnings (semantic
 * sweep, embedding-independent). Keep the earliest; invalidate the later
 * with a deduped_into pointer. Never delete.
 */
async function dedupeLearningsSemantic(
  workspaceId: string,
  threshold: number,
): Promise<number> {
  const rows = await activeLearnings(workspaceId);
  let retired = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = await withWorkerScope(workspaceId, async (tx) =>
      tx.memoryLearning.findUnique({
        where: { id: rows[i].id },
        select: { id: true, invalidatedAt: true },
      }),
    );
    if (!row || row.invalidatedAt) continue; // retired by an earlier pair
    for (let j = i + 1; j < rows.length; j++) {
      if (textSimilarity(rows[i].hypothesis, rows[j].hypothesis) >= threshold) {
        const later = await withWorkerScope(workspaceId, async (tx) =>
          tx.memoryLearning.findUnique({
            where: { id: rows[j].id },
            select: { id: true, invalidatedAt: true },
          }),
        );
        if (!later || later.invalidatedAt) continue;
        try {
          await invalidateLearning(
            workspaceId,
            rows[j].id,
            `semantic duplicate of learning ${rows[i].id} (learning pass dedupe)`,
          );
          retired++;
        } catch {
          /* best-effort; error recorded by caller if needed */
        }
      }
    }
  }
  return retired;
}

/**
 * Decay low-confidence learnings untouched for decayDays: retire via
 * invalidatedAt, never delete. user_told learnings never touched.
 * ("Untouched" ≈ never invalidated/corrected and older than the window —
 * learnings carry no last-used counter.)
 */
async function decayLowConfidenceLearnings(
  workspaceId: string,
  decayDays: number,
  decayConfidence: number,
): Promise<number> {
  return withWorkerScope(workspaceId, async (tx) => {
    const cutoff = new Date(Date.now() - decayDays * 86400_000).toISOString();
    const rows = (await tx.$queryRawUnsafe(
      `UPDATE "memory_learnings"
          SET "invalidated_at" = now(),
              "context_refs" = COALESCE("context_refs", '{}'::jsonb)
                || '{"pruned":"learning_pass_decay"}'::jsonb
        WHERE "workspace_id" = $1
          AND "invalidated_at" IS NULL
          AND "source" = 'consolidation'
          AND "observed_at" < $2::timestamptz
          AND ("context_refs"->>'origin' IS DISTINCT FROM 'user_told')
          AND COALESCE(("metric_delta"->>'confidence')::float, 1.0) < $3
        RETURNING "id"`,
      workspaceId,
      cutoff,
      decayConfidence,
    )) as Array<{ id: string }>;
    return rows.length;
  });
}

/** Voice proposal → pendingUpdates, UNLESS the profile is user-pinned (read-only). */
async function applyVoiceProposal(
  workspaceId: string,
  parsed: LearningPassOutput,
  report: LearningPassReport,
): Promise<void> {
  if (!parsed.voiceProposal) return;
  await withWorkerScope(workspaceId, async (tx) => {
    const profile = await tx.brandVoiceProfile.findUnique({
      where: { workspaceId },
      select: { id: true, pinnedByUser: true },
    });
    if (!profile) return; // voice engine (worker 4) owns creation
    if (profile.pinnedByUser) {
      console.log(
        `[learning-pass] workspace ${workspaceId}: voice profile pinned by user — proposal skipped (read-only).`,
      );
      return;
    }
    const pendingUpdates = scrubJson({
      proposedAt: new Date().toISOString(),
      dimensions: parsed.voiceProposal!.dimensions,
      rationale: parsed.voiceProposal!.rationale,
    }).value as Record<string, unknown>;
    await tx.brandVoiceProfile.update({
      where: { workspaceId },
      data: { pendingUpdates: pendingUpdates as never },
    });
    report.voiceProposed++;
  });
}

/**
 * Knowledge proposals → CompanyKnowledge rows carrying body.needsReview=true
 * (reviewable proposals — user approves in the UI). Never touches pinned
 * rows: only CREATEs, and skips when a same-kind near-duplicate title
 * exists (pinned or not — pinned elements are read-only).
 */
async function applyKnowledgeProposals(
  workspaceId: string,
  parsed: LearningPassOutput,
  report: LearningPassReport,
): Promise<void> {
  if (parsed.knowledge.length === 0) return;
  await withWorkerScope(workspaceId, async (tx) => {
    const existing = await tx.companyKnowledge.findMany({
      where: { workspaceId, validTo: null },
      select: { kind: true, title: true },
      take: 500,
    });
    for (const k of parsed.knowledge) {
      const isDup = existing.some(
        (e) => e.kind === k.kind && textSimilarity(e.title, k.title) >= 0.8,
      );
      if (isDup) continue;
      try {
        const body = scrubJson({
          ...k.body,
          needsReview: true,
        }).value as Record<string, unknown>;
        await tx.companyKnowledge.create({
          data: {
            workspaceId,
            kind: k.kind,
            title: k.title,
            body: body as never,
            confidence: k.confidence,
            pinned: false,
            sourceEpisodeId: null,
            validFrom: new Date(),
          },
        });
        existing.push({ kind: k.kind, title: k.title });
        report.knowledgeProposed++;
      } catch (err) {
        report.errors.push(
          `knowledge "${k.title.slice(0, 80)}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });
}

/**
 * Style-rule candidates → StyleRule rows with active=false,
 * source="consolidation" (live only on user accept). Never touches pinned
 * rules: only CREATEs; skips when the identical pattern already exists.
 */
async function applyStyleRuleProposals(
  workspaceId: string,
  parsed: LearningPassOutput,
  report: LearningPassReport,
): Promise<void> {
  if (parsed.styleRules.length === 0) return;
  await withWorkerScope(workspaceId, async (tx) => {
    const existing = await tx.styleRule.findMany({
      where: { workspaceId },
      select: { pattern: true },
      take: 500,
    });
    const patterns = new Set(existing.map((e) => normalizeLearningText(e.pattern)));
    for (const r of parsed.styleRules) {
      if (patterns.has(normalizeLearningText(r.pattern))) continue;
      try {
        await tx.styleRule.create({
          data: {
            workspaceId,
            kind: r.kind,
            pattern: scrubSecrets(r.pattern).text,
            replacement: r.replacement ? scrubSecrets(r.replacement).text : null,
            severity: r.severity,
            pinned: false,
            active: false,
            source: "consolidation",
          },
        });
        patterns.add(normalizeLearningText(r.pattern));
        report.styleRulesProposed++;
      } catch (err) {
        report.errors.push(
          `styleRule "${r.pattern.slice(0, 80)}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Main entry.
// ---------------------------------------------------------------------------

/**
 * Execute one nightly learning pass for a workspace. Idempotent per night
 * (checks run-row bookkeeping first). Safe to call from
 * executeConsolidationRun or standalone.
 */
export async function executeLearningPass(
  workspaceId: string,
  opts: LearningPassOptions = {},
): Promise<LearningPassReport> {
  const lookbackDays = opts.lookbackDays ?? learningLookbackDays();
  const maxEpisodes = opts.maxEpisodes ?? learningMaxEpisodes();
  const threshold = opts.similarityThreshold ?? learningSimilarityThreshold();
  const decayDays = opts.decayDays ?? learningDecayDays();
  const decayConfidence = opts.decayConfidence ?? learningDecayConfidence();
  const dateLabel = new Date().toISOString().slice(0, 10);

  // 1. Pause toggle — the user-visible contract.
  const paused = await withWorkerScope(workspaceId, async (tx) =>
    getLearningPaused(tx, workspaceId),
  ).catch((err) => {
    const report = emptyReport("failed");
    report.errors.push(
      `pause check: ${err instanceof Error ? err.message : String(err)}`,
    );
    return report as unknown as boolean;
  });
  if (typeof paused !== "boolean") return paused as unknown as LearningPassReport;
  if (paused) {
    console.log(`[learning-pass] workspace ${workspaceId}: learning paused — skipping.`);
    return emptyReport("skipped_paused");
  }

  // 2. One LLM pass per workspace per night.
  try {
    if (await alreadyRanTonight(workspaceId)) {
      console.log(
        `[learning-pass] workspace ${workspaceId}: already ran tonight — skipping.`,
      );
      return emptyReport("skipped_already_ran");
    }
  } catch (err) {
    const report = emptyReport("failed");
    report.errors.push(
      `nightly guard: ${err instanceof Error ? err.message : String(err)}`,
    );
    return report;
  }

  // 3. Gather material.
  let materials: EpisodeMaterial[];
  try {
    materials = await gatherMaterials(workspaceId, lookbackDays, maxEpisodes);
  } catch (err) {
    const report = emptyReport("failed");
    report.errors.push(
      `gather: ${err instanceof Error ? err.message : String(err)}`,
    );
    return report;
  }
  if (materials.length === 0) {
    return emptyReport("skipped_no_material");
  }

  // 4. LLM call (single, bounded).
  const report = emptyReport("ran");
  let raw: string;
  let modelLabel: string;
  try {
    if (opts.llm) {
      modelLabel = opts.modelLabel ?? "injected-test";
      raw = await opts.llm(buildLearningPrompt(workspaceId, materials, dateLabel));
    } else {
      const maxTokens = WORKLOAD_MAX_TOKENS.background;
      const resolved = await defaultLlmGenerate(
        buildLearningPrompt(workspaceId, materials, dateLabel),
        maxTokens,
        workspaceId,
      );
      if (!resolved.live) {
        console.warn(
          `[learning-pass] workspace ${workspaceId}: no live LLM for background workload — LLM pass skipped (mock output must never become durable knowledge).`,
        );
        return emptyReport("skipped_no_llm");
      }
      raw = resolved.text;
      modelLabel = opts.modelLabel ?? resolved.model;
    }
  } catch (err) {
    report.status = "failed";
    report.errors.push(`llm: ${err instanceof Error ? err.message : String(err)}`);
    return report;
  }
  const promptChars = buildLearningPrompt(workspaceId, materials, dateLabel).length;
  report.llmUsage = {
    model: modelLabel,
    promptChars,
    estInputTokens: Math.ceil(promptChars / 4),
    estOutputTokens: Math.ceil(raw.length / 4),
  };
  console.log(
    `[learning-pass] workspace ${workspaceId}: LLM pass on model=${modelLabel} ` +
      `promptChars=${promptChars} estInputTokens=${report.llmUsage.estInputTokens} ` +
      `estOutputTokens=${report.llmUsage.estOutputTokens}`,
  );

  // 5. Parse + apply.
  const parsed = parseLearningPassOutput(raw);
  if (!parsed) {
    report.status = "failed";
    report.errors.push("llm output was not parseable JSON — nothing was written.");
    return report;
  }
  await applyLessons(workspaceId, parsed, modelLabel, dateLabel, threshold, report);
  try {
    report.learningsDecayed = await dedupeLearningsSemantic(workspaceId, threshold);
  } catch (err) {
    report.errors.push(
      `semantic dedupe: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const decayed = await decayLowConfidenceLearnings(
      workspaceId,
      decayDays,
      decayConfidence,
    );
    report.learningsDecayed += decayed;
  } catch (err) {
    report.errors.push(
      `decay: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    await applyVoiceProposal(workspaceId, parsed, report);
  } catch (err) {
    report.errors.push(
      `voice proposal: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    await applyKnowledgeProposals(workspaceId, parsed, report);
  } catch (err) {
    report.errors.push(
      `knowledge proposals: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    await applyStyleRuleProposals(workspaceId, parsed, report);
  } catch (err) {
    report.errors.push(
      `style rules: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (report.errors.length > 0 && report.status === "ran") {
    report.status = "ran"; // partial writes are still a ran pass
  }
  return report;
}

/**
 * Serialize the pass for run-row bookkeeping (rides on
 * memory_consolidation_runs.error JSON next to distilledIds, so episodes
 * stay immutable and no second bookkeeping system appears).
 */
export function learningPassBookkeeping(report: LearningPassReport): Record<string, unknown> {
  return {
    status: report.status,
    at: new Date().toISOString(),
    learningsExtracted: report.learningsExtracted,
    learningsSkippedDup: report.learningsSkippedDup,
    learningsDecayed: report.learningsDecayed,
    voiceProposed: report.voiceProposed,
    knowledgeProposed: report.knowledgeProposed,
    styleRulesProposed: report.styleRulesProposed,
    llmUsage: report.llmUsage,
    errors: report.errors.slice(0, 10),
  };
}

// Re-export the worker pool for the cron route (workspace listing).
export { workerPrisma } from "./consolidate";
