// Marketr — Phase 13B (Worker 2): agent learning capture.
//
// Episode capture + feedback signals for the learning loop (spec §1).
// Contract: docs/phases/13b/DATA-MODEL.md — episodes go to memory_episodes
// (episodeType "agent_call") via the existing Growth Memory write path;
// feedback goes to the AgentFeedback table.
//
// Discipline:
//   - EVERY write is tenant-scoped via withWorkspaceScope (FORCE RLS,
//     fail-closed). The workspaceId is taken ONLY from the function
//     argument — never from the payload — so a caller can never smuggle a
//     foreign workspace id through.
//   - Fail-soft: capture NEVER breaks the agent call it instruments. All
//     three public functions catch everything and return null on failure.
//   - Learning-paused preference (pref:learning_paused) suppresses ALL
//     capture, including explicit feedback — a paused learner records
//     nothing.
//   - Signals are scrubbed of secrets before persistence (scrubJson).
//   - The diff algorithm is dependency-free (line LCS + word LCS in-hunk).

import type { Prisma, FeedbackKind } from "@prisma/client";
import { recordEpisode } from "@/lib/substrate/memory/write";
import { getLearningPaused } from "@/lib/substrate/memory/preferences";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { scrubJson } from "@/lib/substrate/memory/scrub";
import type { EpisodeInput } from "@/lib/substrate/memory/types";

/** Canonical agent ids used as the episode `actor` (expert roles). */
export const LEARNING_AGENT_IDS = [
  "chief-strategy",
  "mission-planner",
  "playbook-generator",
  "content-brief",
] as const;

export const FEEDBACK_KINDS: readonly FeedbackKind[] = [
  "explicit_up",
  "explicit_down",
  "edit_diff",
  "accepted",
  "regenerated",
] as const;

// ---------------------------------------------------------------------------
// Dependency injection (matches the codebase AskDeps/PlannerDeps pattern so
// tests never touch the DB or the embedding model).
// ---------------------------------------------------------------------------

export interface EpisodeWriter {
  (workspaceId: string, input: EpisodeInput): Promise<{ id: string; redactions: number }>;
}

export interface FeedbackWriteInput {
  episodeId?: string | null;
  agentId: string;
  kind: FeedbackKind;
  signal?: Record<string, unknown>;
}

export interface FeedbackWriter {
  (workspaceId: string, input: FeedbackWriteInput): Promise<{ id: string }>;
}

export interface DraftEpisodeLookup {
  (workspaceId: string, contentItemId: string): Promise<{ id: string; draft: string } | null>;
}

export interface CaptureDeps {
  episodeWriter?: EpisodeWriter;
  feedbackWriter?: FeedbackWriter;
  draftEpisodeLookup?: DraftEpisodeLookup;
  /** Defaults to reading pref:learning_paused under the workspace scope. */
  isPaused?: (workspaceId: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Defaults (real implementations)
// ---------------------------------------------------------------------------

async function defaultIsPaused(workspaceId: string): Promise<boolean> {
  return withWorkspaceScope(workspaceId, (tx) => getLearningPaused(tx, workspaceId));
}

async function defaultFeedbackWriter(
  workspaceId: string,
  input: FeedbackWriteInput,
): Promise<{ id: string }> {
  const scrubbed = scrubJson(input.signal ?? {});
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.agentFeedback.create({
      data: {
        // workspaceId comes from the scope argument ONLY — never the payload.
        workspaceId,
        episodeId: input.episodeId ?? null,
        agentId: input.agentId.slice(0, 120),
        kind: input.kind,
        signal: (scrubbed.value ?? {}) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { id: row.id };
  });
}

/**
 * Latest agent_call episode whose refs carry this content item id AND the
 * full agent draft (refs.draftFull). Written by the draft-generation hook;
 * read by the editor-save hook to compute the edit diff.
 */
export async function findLatestDraftEpisode(
  workspaceId: string,
  contentItemId: string,
  deps: CaptureDeps = {},
): Promise<{ id: string; draft: string } | null> {
  try {
    const lookup = deps.draftEpisodeLookup ?? defaultDraftEpisodeLookup;
    return await lookup(workspaceId, contentItemId);
  } catch {
    return null;
  }
}

async function defaultDraftEpisodeLookup(
  workspaceId: string,
  contentItemId: string,
): Promise<{ id: string; draft: string } | null> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.memoryEpisode.findFirst({
      where: {
        workspaceId,
        episodeType: "agent_call",
        refs: { path: ["contentItemId"], equals: contentItemId },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, refs: true },
    });
    if (!row) return null;
    const refs = (row.refs ?? {}) as Record<string, unknown>;
    const draft = typeof refs.draftFull === "string" ? refs.draftFull : null;
    return draft ? { id: row.id, draft } : null;
  });
}

// ---------------------------------------------------------------------------
// 1. Episode capture
// ---------------------------------------------------------------------------

export interface CaptureEpisodeInput {
  workspaceId: string;
  agentId: string;
  promptSummary: string;
  outputSummary?: string;
  outcome?: string;
  startedAt?: Date;
  endedAt?: Date;
  /** Extra refs merged into the episode refs (e.g. contentItemId, draftFull). */
  refs?: Record<string, unknown>;
}

const SUMMARY_FLOOR = 12; // mirrors assertWriteWorthy in the memory write path

/**
 * Record an agent_call episode. Returns the episode id, or null when
 * learning is paused or the write failed (fail-soft — never throws).
 */
export async function captureEpisode(
  input: CaptureEpisodeInput,
  deps: CaptureDeps = {},
): Promise<string | null> {
  try {
    if (!input.workspaceId || !input.agentId) return null;
    const isPaused = deps.isPaused ?? defaultIsPaused;
    if (await isPaused(input.workspaceId)) return null;

    const prompt = (input.promptSummary ?? "").trim();
    let summary = `agent_call:${input.agentId} — ${prompt.slice(0, 160)}`.trim();
    if (summary.length < SUMMARY_FLOOR) summary = `agent_call:${input.agentId} (no prompt captured)`;

    const writer: EpisodeWriter = deps.episodeWriter ?? recordEpisode;
    const { id } = await writer(input.workspaceId, {
      episodeType: "agent_call",
      actor: input.agentId,
      summary,
      refs: {
        promptSummary: prompt.slice(0, 2000),
        outputSummary: (input.outputSummary ?? "").slice(0, 4000),
        outcome: input.outcome ?? "completed",
        ...(input.refs ?? {}),
      },
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? new Date(),
    });
    return id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. Feedback signals
// ---------------------------------------------------------------------------

export interface RecordFeedbackInput extends FeedbackWriteInput {
  workspaceId: string;
}

/**
 * Record an AgentFeedback row (explicit_up/down, edit_diff, accepted,
 * regenerated). Returns the row id, or null when learning is paused, the
 * kind is invalid, or the write failed (fail-soft — never throws).
 */
export async function recordFeedback(
  input: RecordFeedbackInput,
  deps: CaptureDeps = {},
): Promise<string | null> {
  try {
    if (!input.workspaceId || !input.agentId) return null;
    if (!FEEDBACK_KINDS.includes(input.kind)) return null;
    const isPaused = deps.isPaused ?? defaultIsPaused;
    if (await isPaused(input.workspaceId)) return null;

    const writer: FeedbackWriter = deps.feedbackWriter ?? defaultFeedbackWriter;
    const { id } = await writer(input.workspaceId, {
      episodeId: input.episodeId ?? null,
      agentId: input.agentId,
      kind: input.kind,
      signal: input.signal ?? {},
    });
    return id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. Dependency-free text diff (line LCS → hunks → word LCS inside hunks)
// ---------------------------------------------------------------------------

const MAX_DIFF_LINES = 1200;
const MAX_HUNK_WORDS = 2000;
const MAX_HUNKS = 12;
const EXCERPT_CHARS = 280;

export interface DiffHunk {
  type: "added" | "removed" | "replaced";
  /** 1-based line number in the BEFORE text where the hunk starts. */
  atLine: number;
  linesAdded: number;
  linesRemoved: number;
  excerpt: string;
}

export interface TextDiff {
  identical: boolean;
  linesAdded: number;
  linesRemoved: number;
  wordsAdded: number;
  wordsRemoved: number;
  hunks: DiffHunk[];
  /** True when either side was truncated to the diff caps. */
  truncated: boolean;
  toneHints: string[];
}

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function excerptOf(lines: string[]): string {
  return lines.slice(0, 3).join("\n").slice(0, EXCERPT_CHARS);
}

/**
 * LCS op sequence for two token arrays ("same" | "del" | "add").
 * Full DP matrix is kept for backtracking; inputs are capped by callers.
 */
function lcsOps(a: string[], b: string[]): Array<"same" | "del" | "add"> {
  const n = a.length;
  const m = b.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  const idx = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[idx(i, j)] =
        a[i - 1] === b[j - 1]
          ? dp[idx(i - 1, j - 1)] + 1
          : Math.max(dp[idx(i - 1, j)], dp[idx(i, j - 1)]);
    }
  }
  const ops: Array<"same" | "del" | "add"> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push("same");
      i--;
      j--;
    } else if (dp[idx(i - 1, j)] >= dp[idx(i, j - 1)]) {
      ops.push("del");
      i--;
    } else {
      ops.push("add");
      j--;
    }
  }
  while (i > 0) {
    ops.push("del");
    i--;
  }
  while (j > 0) {
    ops.push("add");
    j--;
  }
  return ops.reverse();
}

function wordTokens(text: string): string[] {
  const t = text.trim();
  return t ? t.split(/\s+/) : [];
}

/** Word-level added/removed counts between two texts (LCS on word tokens). */
function wordDelta(beforeText: string, afterText: string): { added: number; removed: number } {
  let a = wordTokens(beforeText);
  let b = wordTokens(afterText);
  if (a.length > MAX_HUNK_WORDS) a = a.slice(0, MAX_HUNK_WORDS);
  if (b.length > MAX_HUNK_WORDS) b = b.slice(0, MAX_HUNK_WORDS);
  const ops = lcsOps(a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op === "add") added++;
    else if (op === "del") removed++;
  }
  return { added, removed };
}

function countChar(text: string, ch: string): number {
  let n = 0;
  for (let k = 0; k < text.length; k++) if (text[k] === ch) n++;
  return n;
}

function countRe(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * Cheap tone-shift heuristics between draft and final. Heuristic only —
 * the consolidation job (Worker 3) does the real interpretation.
 */
function toneHints(before: string, after: string): string[] {
  const hints: string[] = [];
  const push = (delta: number, one: string, many: string) => {
    if (delta === 0) return;
    const word = Math.abs(delta) === 1 ? one : many;
    hints.push(`${delta > 0 ? "+" : "−"}${Math.abs(delta)} ${word}`);
  };

  push(countChar(after, "!") - countChar(before, "!"), "exclamation", "exclamations");
  push(countChar(after, "?") - countChar(before, "?"), "question mark", "question marks");
  push(
    countRe(after, /\b(i|me|my|mine|we|us|our|ours)\b/gi) -
      countRe(before, /\b(i|me|my|mine|we|us|our|ours)\b/gi),
    "first-person pronoun",
    "first-person pronouns",
  );
  push(
    countRe(after, /\b(just|really|very|actually|perhaps|maybe|quite|rather)\b/gi) -
      countRe(before, /\b(just|really|very|actually|perhaps|maybe|quite|rather)\b/gi),
    "softener",
    "softeners",
  );

  const avgSentence = (t: string): number => {
    const sentences = t.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length === 0) return 0;
    return countWords(t) / sentences.length;
  };
  const sentDelta = avgSentence(after) - avgSentence(before);
  if (Math.abs(sentDelta) >= 1.5) {
    hints.push(
      `${sentDelta > 0 ? "longer" : "shorter"} sentences (${sentDelta > 0 ? "+" : "−"}${Math.abs(sentDelta).toFixed(1)} words/sentence)`,
    );
  }

  const wordDeltaTotal = countWords(after) - countWords(before);
  if (Math.abs(wordDeltaTotal) >= 20) {
    hints.push(`${wordDeltaTotal > 0 ? "+" : "−"}${Math.abs(wordDeltaTotal)} words total`);
  }
  return hints;
}

/**
 * Dependency-free diff between an agent draft and the user's final version.
 * Line-level LCS finds the changed hunks; word-level LCS inside replaced
 * hunks gives word add/remove counts.
 */
export function diffText(before: string, after: string): TextDiff {
  const b = before ?? "";
  const a = after ?? "";
  if (b === a) {
    return {
      identical: true,
      linesAdded: 0,
      linesRemoved: 0,
      wordsAdded: 0,
      wordsRemoved: 0,
      hunks: [],
      truncated: false,
      toneHints: [],
    };
  }

  let bLines = b.split("\n");
  let aLines = a.split("\n");
  let truncated = false;
  if (bLines.length > MAX_DIFF_LINES) {
    bLines = bLines.slice(0, MAX_DIFF_LINES);
    truncated = true;
  }
  if (aLines.length > MAX_DIFF_LINES) {
    aLines = aLines.slice(0, MAX_DIFF_LINES);
    truncated = true;
  }

  const ops = lcsOps(bLines, aLines);
  const hunks: DiffHunk[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  let wordsAdded = 0;
  let wordsRemoved = 0;

  let bi = 0; // index into bLines
  let ai = 0; // index into aLines
  let k = 0;
  while (k < ops.length) {
    if (ops[k] === "same") {
      bi++;
      ai++;
      k++;
      continue;
    }
    // Collect one hunk: consecutive non-"same" ops.
    const dels: string[] = [];
    const adds: string[] = [];
    const atLine = bi + 1; // 1-based, in BEFORE coordinates
    while (k < ops.length && ops[k] !== "same") {
      if (ops[k] === "del") {
        dels.push(bLines[bi]);
        bi++;
      } else {
        adds.push(aLines[ai]);
        ai++;
      }
      k++;
    }

    const type = dels.length > 0 && adds.length > 0 ? "replaced" : dels.length > 0 ? "removed" : "added";
    linesAdded += adds.length;
    linesRemoved += dels.length;
    if (type === "replaced") {
      const wd = wordDelta(dels.join("\n"), adds.join("\n"));
      wordsAdded += wd.added;
      wordsRemoved += wd.removed;
    } else if (type === "added") {
      wordsAdded += countWords(adds.join("\n"));
    } else {
      wordsRemoved += countWords(dels.join("\n"));
    }
    if (hunks.length < MAX_HUNKS) {
      hunks.push({
        type,
        atLine,
        linesAdded: adds.length,
        linesRemoved: dels.length,
        excerpt: excerptOf([...dels.map((l) => `− ${l}`), ...adds.map((l) => `+ ${l}`)]),
      });
    }
  }

  return {
    identical: false,
    linesAdded,
    linesRemoved,
    wordsAdded,
    wordsRemoved,
    hunks,
    truncated,
    toneHints: toneHints(b, a),
  };
}

// ---------------------------------------------------------------------------
// 3b. Edit-diff summarization (deterministic, LLM-free)
// ---------------------------------------------------------------------------

export interface EditDiffSummary {
  summary: string;
  diffStats: {
    linesAdded: number;
    linesRemoved: number;
    wordsAdded: number;
    wordsRemoved: number;
    hunks: number;
    truncated: boolean;
    identical: boolean;
    /** Most salient removed/added tokens (lowercased, content words). */
    removedTokens: string[];
    addedTokens: string[];
  };
}

const SUMMARY_STOPWORDS = new Set(
  "the,a,an,to,of,and,or,in,on,for,with,is,are,was,were,be,been,it,its,this,that,these,those,you,your,we,our,us,they,their,he,she,his,her,at,by,from,as,so,but,if,then,than,too,very,can,will,just,not,no,do,does,did,have,has,had,all,any,each,more,most,other,some,such,only,own,same,up,out,about,into,over,after,before".split(","),
);

function diffTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []).filter(
    (t) => t.length > 2 && !SUMMARY_STOPWORDS.has(t),
  );
}

/**
 * Deterministic human-readable summary of an agent-draft → user-final edit,
 * plus the diff stats. Used by the feedback pipeline and the 13B eval
 * battery (FEEDBACK_DIFF_PAIRS). No LLM call.
 */
export async function summarizeEditDiff(
  before: string,
  after: string,
): Promise<EditDiffSummary> {
  const d = diffText(before ?? "", after ?? "");
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  for (const t of diffTokens(before ?? "")) beforeCounts.set(t, (beforeCounts.get(t) ?? 0) + 1);
  for (const t of diffTokens(after ?? "")) afterCounts.set(t, (afterCounts.get(t) ?? 0) + 1);
  const removedTokens: string[] = [];
  const addedTokens: string[] = [];
  for (const [t, n] of beforeCounts) {
    const still = afterCounts.get(t) ?? 0;
    for (let i = 0; i < n - still; i++) removedTokens.push(t);
  }
  for (const [t, n] of afterCounts) {
    const was = beforeCounts.get(t) ?? 0;
    for (let i = 0; i < n - was; i++) addedTokens.push(t);
  }
  // Salience: frequency then first-seen order, capped for readability.
  const top = (toks: string[]) => {
    const freq = new Map<string, number>();
    const order: string[] = [];
    for (const t of toks) {
      if (!freq.has(t)) order.push(t);
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    return order.sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0)).slice(0, 10);
  };
  const removed = top(removedTokens);
  const added = top(addedTokens);
  const diffStats = {
    linesAdded: d.linesAdded,
    linesRemoved: d.linesRemoved,
    wordsAdded: d.wordsAdded,
    wordsRemoved: d.wordsRemoved,
    hunks: d.hunks.length,
    truncated: d.truncated,
    identical: d.identical,
    removedTokens: removed,
    addedTokens: added,
  };
  if (d.identical) {
    return { summary: "User accepted the draft unchanged.", diffStats };
  }
  const parts = [
    `User edited the draft: ${d.wordsAdded} word(s) added, ${d.wordsRemoved} removed across ${d.hunks.length} change(s).`,
  ];
  if (removed.length > 0) parts.push(`Removed: ${removed.slice(0, 6).join(", ")}.`);
  if (added.length > 0) parts.push(`Added: ${added.slice(0, 6).join(", ")}.`);
  if (d.truncated) parts.push("Diff truncated to caps.");
  return { summary: parts.join(" "), diffStats };
}

// ---------------------------------------------------------------------------
// 4. Edit-diff pipeline
// ---------------------------------------------------------------------------

export interface CaptureEditDiffInput {
  workspaceId: string;
  /** Episode the draft came from (omitted when unknown). */
  episodeId?: string | null;
  agentId: string;
  /** The agent-produced draft (as stored, e.g. in the episode refs). */
  draft: string;
  /** The user's final version after editing/saving. */
  final: string;
  /** Where the save happened, e.g. "content_editor". */
  source?: string;
}

/**
 * Compare an agent draft with the user's final version and record the
 * feedback signal: kind "edit_diff" with the diff stats, or "accepted"
 * (withEdits: false) when the user saved without changes. Fail-soft.
 */
export async function captureEditDiff(
  input: CaptureEditDiffInput,
  deps: CaptureDeps = {},
): Promise<string | null> {
  try {
    const draft = input.draft ?? "";
    const final = input.final ?? "";
    if (draft.trim() === final.trim()) {
      return recordFeedback(
        {
          workspaceId: input.workspaceId,
          episodeId: input.episodeId ?? null,
          agentId: input.agentId,
          kind: "accepted",
          signal: { withEdits: false, source: input.source ?? "editor" },
        },
        deps,
      );
    }
    const diff = diffText(draft, final);
    return recordFeedback(
      {
        workspaceId: input.workspaceId,
        episodeId: input.episodeId ?? null,
        agentId: input.agentId,
        kind: "edit_diff",
        signal: {
          before: draft.slice(0, 4000),
          after: final.slice(0, 4000),
          diffStats: {
            linesAdded: diff.linesAdded,
            linesRemoved: diff.linesRemoved,
            wordsAdded: diff.wordsAdded,
            wordsRemoved: diff.wordsRemoved,
            changedRegions: diff.hunks.map((h) => ({
              type: h.type,
              atLine: h.atLine,
              linesAdded: h.linesAdded,
              linesRemoved: h.linesRemoved,
              excerpt: h.excerpt,
            })),
            toneHints: diff.toneHints,
            truncated: diff.truncated,
          },
          source: input.source ?? "editor",
        },
      },
      deps,
    );
  } catch {
    return null;
  }
}

/**
 * Convenience for editor-save routes: look up the latest agent draft for a
 * content item and record the edit-diff/accepted signal against it. Returns
 * null when there is no agent draft to diff against (e.g. manually created
 * content) or when capture is paused/failed.
 */
export async function captureContentSaveDiff(
  workspaceId: string,
  contentItemId: string,
  finalBody: string,
  opts: { agentId?: string; source?: string } = {},
  deps: CaptureDeps = {},
): Promise<string | null> {
  try {
    const lookup = deps.draftEpisodeLookup ?? defaultDraftEpisodeLookup;
    const found = await lookup(workspaceId, contentItemId);
    if (!found) return null;
    return captureEditDiff(
      {
        workspaceId,
        episodeId: found.id,
        agentId: opts.agentId ?? "content-brief",
        draft: found.draft,
        final: finalBody,
        source: opts.source ?? "content_editor",
      },
      deps,
    );
  } catch {
    return null;
  }
}
