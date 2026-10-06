// ShapesOS — Phase 17 (latency, A8): the answer cache for repeated
// FAQ-style questions.
//
// Key: workspace + project + a hash of the WHOLE model input — the system
// prompt (project context, company intelligence, recall: the data version is
// in there, so any change to the data the answer was grounded in changes the
// key), the thread history and the question itself. Identical input would
// get the model's same answer (modulo sampling), so the earlier one is
// reused and the model is not called. Only an answer that used NO tools and
// raised NO approval is stored (lib/chat/agent.ts decides); a turn with
// attachments never reads the cache. The reply is labelled (the
// `cached_answer` marker on the assistant row, CUSTOM marketr.cached on the
// stream) so the person knows it was reused.
//
// In-process on purpose: one turn runs on one instance, the cache is a
// latency win on repeats, not a correctness store — a miss on another
// replica just calls the model. Bounded (ANSWER_CACHE_MAX entries, LRU) and
// short-lived (ANSWER_CACHE_TTL_MS).

import { createHash } from "node:crypto";
import type { ChatMessage } from "@/lib/llm/types";
import type { ChatToolCall } from "./tool-exec";

export const ANSWER_CACHE_TTL_MS = 10 * 60_000;
export const ANSWER_CACHE_MAX = 500;
/** The marker call a cached answer carries (the chat shows a "Cached answer" label, not a chip). */
export const CACHED_ANSWER_TOOL = "cached_answer";

/** Lower-case, collapse whitespace, strip trailing punctuation: "What's my score?" ≡ "what's my score". */
export function normalizeQuestion(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[\s?.!]+$/u, "");
}

/**
 * The cache key for a turn's model input, or null when the turn should not
 * use the cache (an empty question).
 */
export function answerCacheKey(input: { workspaceId: string; projectId: string; system: string; messages: readonly ChatMessage[] }): string | null {
  const last = input.messages[input.messages.length - 1];
  const question = last && last.role === "user" && typeof last.content === "string" ? normalizeQuestion(last.content) : "";
  if (!question) return null;
  const history = input.messages.slice(0, -1).map((m) => `${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`);
  const h = createHash("sha256");
  h.update(input.system);
  h.update("\u0000");
  h.update(history.join("\u0001"));
  h.update("\u0000");
  h.update(question);
  return `${input.workspaceId}:${input.projectId}:${h.digest("hex")}`;
}

export interface CachedAnswer {
  text: string;
}

/** A small TTL + LRU map. */
export class AnswerCache {
  private readonly map = new Map<string, { at: number; value: CachedAnswer }>();
  constructor(
    private readonly ttlMs = ANSWER_CACHE_TTL_MS,
    private readonly max = ANSWER_CACHE_MAX,
    private readonly now: () => number = Date.now,
  ) {}
  get(key: string): CachedAnswer | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (this.now() - hit.at >= this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // LRU: a hit moves to the back.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, value: CachedAnswer): void {
    if (!value.text.trim()) return;
    this.map.delete(key);
    this.map.set(key, { at: this.now(), value });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  /** Drop every entry of a workspace (a test, or a write that must not be served stale). */
  invalidateWorkspace(workspaceId: string): void {
    for (const k of [...this.map.keys()]) if (k.startsWith(`${workspaceId}:`)) this.map.delete(k);
  }
  get size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}

export const answerCache = new AnswerCache();

/** The marker call saved with a cached answer. */
export function cachedAnswerCall(question: string): ChatToolCall {
  return { tool: CACHED_ANSWER_TOOL, args: { question: question.slice(0, 200) }, status: "executed", resultSummary: "Reused a recent answer to the same question (no model call)." };
}
