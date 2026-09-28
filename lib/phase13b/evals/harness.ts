// Marketr — Phase 13B eval harness (worker 7).
//
// Shared plumbing for the 7 acceptance suites in this directory:
//   01-lesson-quality        02-preference-precision   03-style-rule-enforcement
//   04-voice-fidelity        05-no-ghost-recall        06-stop-asking
//   07-feedback-diff
//
// Every suite is a node:test file (repo pattern: `npx tsx --test <file>`).
// Run all with `npx tsx lib/phase13b/evals/run-evals.mts`, which prints a
// clear PASS / PENDING / FAIL summary per suite.
//
// Pending policy (per the task brief): if a feature module another worker
// owns has not landed yet, the dependent tests are SKIPPED with a reason
// naming the missing module — the suite reports PENDING, never FAIL.
// A suite reports FAIL only on a genuine contract violation in code that
// exists.
//
// ---------------------------------------------------------------------------
// CONTRACT: expected feature-module shapes (for workers 2/4/5/6).
// The probes below look for these entry points. If your module landed at a
// different path with the same exported shape, add the path to the probe
// list — the evals adapt automatically.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { prisma } from "../../prisma";

/** Probe result for a not-yet-landed feature module. */
export interface FeatureProbe {
  found: boolean;
  /** Imported module when found, null otherwise. */
  module: Record<string, unknown> | null;
  /** Human reason used in SKIP messages when not found. */
  reason: string;
}

/**
 * Look for a feature implementation at any of the candidate module paths.
 * Candidates are relative to THIS directory's parent (lib/phase13b/) or the
 * repo root via @-style relative hops.
 */
export async function probeFeature(
  ownerWorker: string,
  candidates: string[],
  expectedShape: string,
): Promise<FeatureProbe> {
  for (const c of candidates) {
    try {
      const mod = (await import(c)) as Record<string, unknown>;
      if (mod && Object.keys(mod).length > 0) {
        return { found: true, module: mod, reason: "" };
      }
    } catch {
      // not landed yet — try the next candidate
    }
  }
  return {
    found: false,
    module: null,
    reason:
      `${ownerWorker} feature module not landed (looked for: ${candidates.join(", ")}; ` +
      `expected shape: ${expectedShape}) — suite PENDING, battery ready for reuse.`,
  };
}

/** Expected feature shapes (documentation for the owning workers). */
export const EXPECTED = {
  consolidationExtractor:
    "extractLessons(episodes: Episode[], llm: (prompt)=>Promise<string>) => Promise<LessonCandidate[]> " +
    "or consolidateWorkspace(workspaceId, { llm }) — worker 6",
  styleRuleCheck:
    "checkOutput(workspaceId, text) => Promise<{ violations: [{ ruleId, kind, severity, message }], blocked: boolean }> — worker 2",
  voiceDerivation:
    "deriveVoiceProfile(workspaceId, samples: string[]) => Promise<BrandVoiceDimensions>; " +
    "applyVoiceProfile(profile, draft) => Promise<string> — worker 2",
  intelligenceContext:
    "buildIntelligenceContext(workspaceId) => Promise<{ systemPrompt: string } | string> — worker 5",
  feedbackDiff:
    "summarizeEditDiff(before: string, after: string) => Promise<{ summary: string, diffStats: object }> — worker 4",
} as const;

/**
 * Test-name helper for pending feature blocks. node:test's TAP reporter
 * renders a STRING skip reason as `not ok ... # SKIP` (a quirk — boolean
 * `skip: true` renders `ok ... # SKIP` and keeps parent describes green),
 * so pending blocks use boolean skip with the reason embedded in the name.
 */
export function pendingName(base: string, probe: FeatureProbe, fallbackReason: string): string {
  if (probe.found) return base;
  // NOTE: it() names are computed at file-load time, before before()
  // populates the probe — so callers pass a static fallbackReason; the
  // live probe.reason (when available) takes precedence.
  const raw = probe.reason || fallbackReason;
  const r = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
  return `${base} — PENDING: ${r}`;
}
export function evalWorkspaceId(suite: string): string {
  return `eval13b_${suite}_${randomUUID().slice(0, 8)}`;
}

const EVAL_OWNER = "eval13b";

/** Create a workspace for a suite; teardown deletes it (cascades to 13b tables). */
export async function createEvalWorkspace(suite: string, name: string): Promise<string> {
  const id = evalWorkspaceId(suite);
  await prisma.workspace.create({ data: { id, name, ownerUserId: EVAL_OWNER } });
  return id;
}

export async function deleteEvalWorkspace(id: string): Promise<void> {
  await prisma.workspace.deleteMany({ where: { id } });
}

// ---------------------------------------------------------------------------
// Lesson-quality rubric helpers (suite 01).
// ---------------------------------------------------------------------------

/** Triviality templates the consolidation extractor must never emit as lessons. */
export const TRIVIAL_TEMPLATES = [
  /did (a |some |the )?thing/i,
  /user edited (the )?text/i,
  /agent (responded|replied|answered)/i,
  /^(ok|yes|no|done|thanks)\.?$/i,
  /content was (created|generated|produced)/i,
];

/** A lesson is non-trivial if it is substantive, specific, and not a template. */
export function assertNonTrivialLesson(hypothesis: string): void {
  const words = hypothesis.trim().split(/\s+/);
  if (words.length < 8) {
    throw new Error(`Trivial lesson (too short, ${words.length} words): ${JSON.stringify(hypothesis)}`);
  }
  for (const t of TRIVIAL_TEMPLATES) {
    if (t.test(hypothesis)) {
      throw new Error(`Trivial lesson (matches template ${t}): ${JSON.stringify(hypothesis)}`);
    }
  }
}

/** Token-overlap similarity (0..1); consolidation must not emit near-dupes. */
export function tokenOverlap(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** Assert no pair of lessons is near-duplicate (overlap < threshold). */
export function assertNoDuplicateLessons(hypotheses: string[], threshold = 0.6): void {
  for (let i = 0; i < hypotheses.length; i++) {
    for (let j = i + 1; j < hypotheses.length; j++) {
      const sim = tokenOverlap(hypotheses[i], hypotheses[j]);
      if (sim >= threshold) {
        throw new Error(
          `Duplicate lessons (overlap ${sim.toFixed(2)} >= ${threshold}):\n  1. ${hypotheses[i]}\n  2. ${hypotheses[j]}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic word-diff (suite 07 fixture sanity; NOT the pipeline).
// ---------------------------------------------------------------------------

export interface WordDiff {
  removed: string[];
  added: string[];
  removedCount: number;
  addedCount: number;
}

/** Simple LCS word diff — sanity-checks fixture design only. */
export function wordDiff(before: string, after: string): WordDiff {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(a[i++]);
    } else {
      added.push(b[j++]);
    }
  }
  while (i < m) removed.push(a[i++]);
  while (j < n) added.push(b[j++]);
  return { removed, added, removedCount: removed.length, addedCount: added.length };
}
