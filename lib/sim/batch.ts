// ShapesOS — Phase 19B (WS=engine): the Batch API path for "deep" town runs.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// Anthropic's Message Batches run requests asynchronously at 50 % of
// standard prices. A deep run sends each big decision round — the nightly
// reflections of every resident who did something launch-related that day
// — as ONE batch through the router's Anthropic provider
// (AnthropicLlmProvider.submitChatBatch / chatBatchResults: chat()'s exact
// params, spend-gated and metered at the batch tier), waits for it with a
// backed-off poll, then maps each result back by custom_id (results come in
// any order). Small rounds (under `minBatch`) go to the `direct` decider.
//
// The hard cap still holds: every request reserves its worst case at the
// batch tier on the run's PanelLedger BEFORE the batch is sent (a request
// that doesn't fit stops the run cleanly — nothing is submitted), and each
// result settles at its actual batch-tier credits. errored / canceled /
// expired results and answers that fail their schema fall back to rules,
// labelled; a batch has no per-request retry. Cached decisions never enter
// a batch. Tested against a fake client with the documented shapes; the live
// call is UNVERIFIED-LIVE.

import type { ChatMessage, ChatRequest, ChatResponse, ChatUsageContext } from "@/lib/llm/types";
import { PanelLedger, worstCaseCallCredits, type Reservation } from "@/lib/panel/budget";
import { toolInputSchema } from "@/lib/panel/model";
import { DECISION_MAX_TOKENS, DECISION_TOOLS, decisionPrompt, ruleDecision, type AnyDecisionValue, type Decision, type DecisionCache, type DecisionRequest, type TownDecider } from "./decisions";

/** The slice of AnthropicLlmProvider the batch path uses (a test seam). */
export interface ChatBatchProvider {
  getModel(): string;
  submitChatBatch(requests: ReadonlyArray<{ customId: string; req: ChatRequest }>, usage?: ChatUsageContext): Promise<{ providerBatchId: string; status: string }>;
  batchStatus(providerBatchId: string): Promise<{ ended: boolean; status: string }>;
  chatBatchResults(providerBatchId: string, requests: ReadonlyMap<string, ChatRequest>, usage?: ChatUsageContext): Promise<Record<string, ChatResponse | { error: string }>>;
}

export interface BatchTownDeciderOptions {
  provider: ChatBatchProvider;
  ledger: PanelLedger;
  cache: DecisionCache;
  /** Rounds smaller than minBatch (and everything when batching is off) go here. */
  direct: TownDecider;
  minBatch?: number;
  usage?: ChatUsageContext;
  pollFirstMs?: number;
  pollMaxMs?: number;
  /** Give up waiting after this long (the round then falls back to rules). Default 24 h, the Batches limit. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export const BATCH_TIER = { serviceTier: "batch" } as const;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BatchTownDecider implements TownDecider {
  readonly kind = "live" as const;
  private batchesSent = 0;

  constructor(private readonly o: BatchTownDeciderOptions) {}

  get batches(): number {
    return this.batchesSent;
  }

  async decideMany(runId: string, reqs: DecisionRequest[]): Promise<Decision[]> {
    const fresh = new Map<string, DecisionRequest>();
    for (const r of reqs) if (!this.o.cache.get(r.key) && !fresh.has(r.key)) fresh.set(r.key, r);
    if (fresh.size < (this.o.minBatch ?? 20)) return this.o.direct.decideMany(runId, reqs);

    const model = this.o.provider.getModel();
    const items = [...fresh.values()].map((r, i) => {
      const { system, user } = decisionPrompt(r.point, r.facts);
      const tool = DECISION_TOOLS[r.point];
      const req: ChatRequest = {
        system: `${system}\n\nAnswer ONLY by calling the ${tool.name} tool exactly once.`,
        messages: [{ role: "user", content: user } satisfies ChatMessage],
        tools: [{ name: tool.name, description: tool.description, inputSchema: toolInputSchema(tool.schema) }],
        toolChoice: { name: tool.name },
        maxTokens: DECISION_MAX_TOKENS[r.point],
        usage: this.o.usage,
      };
      const chars = (req.system as string).length + user.length + JSON.stringify(req.tools![0]!.inputSchema).length;
      return { customId: `d${i + 1}`, r, req, worst: worstCaseCallCredits(model, chars, req.maxTokens, BATCH_TIER) };
    });
    // Reserve every request's worst case first: the cap holds before anything is sent.
    const reservations: Reservation[] = [];
    try {
      for (const it of items) reservations.push(this.o.ledger.reserve(runId, it.worst));
    } catch (err) {
      for (const res of reservations) this.o.ledger.release(res);
      throw err;
    }

    const answered = new Map<string, { value: AnyDecisionValue; source: "model" | "rules"; credits: number; note?: string }>();
    let results: Record<string, ChatResponse | { error: string }> = {};
    try {
      const { providerBatchId } = await this.o.provider.submitChatBatch(items.map((it) => ({ customId: it.customId, req: it.req })), this.o.usage);
      this.batchesSent += 1;
      const sleep = this.o.sleep ?? realSleep;
      const first = this.o.pollFirstMs ?? 60_000;
      const max = this.o.pollMaxMs ?? 15 * 60_000;
      let waited = 0;
      for (let polls = 0; ; polls++) {
        const ms = Math.min(max, first * 2 ** polls);
        await sleep(ms);
        waited += ms;
        if (this.o.signal?.aborted) throw this.o.signal.reason ?? new Error("aborted");
        if ((await this.o.provider.batchStatus(providerBatchId)).ended) break;
        if (waited >= (this.o.maxWaitMs ?? 24 * 3_600_000)) throw new Error(`batch ${providerBatchId} did not end within ${Math.round(waited / 60_000)} min`);
      }
      results = await this.o.provider.chatBatchResults(providerBatchId, new Map(items.map((it) => [it.customId, it.req])), this.o.usage);
    } catch (err) {
      for (const res of reservations) this.o.ledger.release(res);
      throw err;
    }

    items.forEach((it, i) => {
      const res = results[it.customId];
      const reservation = reservations[i]!;
      const fallback = (note: string) => answered.set(it.r.key, { value: ruleDecision(it.r.point, it.r.facts, it.r.key), source: "rules", credits: 0, note });
      if (!res) {
        this.o.ledger.release(reservation);
        return fallback("batch result missing");
      }
      if ("error" in res) {
        this.o.ledger.release(reservation);
        return fallback(`batch result ${res.error.slice(0, 120)}`);
      }
      const credits = this.o.ledger.settle(reservation, model, res.usage, it.r.point, BATCH_TIER);
      const block = res.content.find((b) => b.type === "tool_use" && b.name === DECISION_TOOLS[it.r.point].name);
      const parsed = block && block.type === "tool_use" && !block.invalid ? DECISION_TOOLS[it.r.point].schema.safeParse(block.input) : null;
      if (!parsed?.success) {
        answered.set(it.r.key, { value: ruleDecision(it.r.point, it.r.facts, it.r.key), source: "rules", credits, note: "batch answer failed its schema" });
        return;
      }
      answered.set(it.r.key, { value: parsed.data as AnyDecisionValue, source: "model", credits });
      this.o.cache.set(it.r.key, parsed.data as AnyDecisionValue);
    });

    const seen = new Set<string>();
    return reqs.map((r) => {
      const a = answered.get(r.key);
      if (a && !seen.has(r.key)) {
        seen.add(r.key);
        this.o.cache.misses += 1;
        return { point: r.point, key: r.key, value: a.value, source: a.source, credits: a.credits, ...(a.note ? { note: a.note } : {}) };
      }
      this.o.cache.hits += 1;
      return { point: r.point, key: r.key, value: (this.o.cache.get(r.key) ?? a!.value) as AnyDecisionValue, source: "cache" as const, credits: 0 };
    });
  }
}
