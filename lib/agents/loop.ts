// ShapesOS — Phase 8: the native agent loop (Claude Code / Cursor-grade).
//
// One loop for every agent run: a chat turn, a delegated sub-agent, a mission
// step, a scheduled skill. It talks to the model through Phase 7's
// chat()/chatStream() with NATIVE tools (no JSON-in-text), and keeps every
// Phase 5 guarantee:
//
//   * Tools: the ToolDef catalog (allTools(), so tools other modules register
//     at runtime — the sandbox code tools — are included) plus the project's
//     connector tools, filtered by the task's grant (lib/agents/loop-tools.ts).
//     Claude's server-side web_search / web_fetch are on when the grant has
//     the web group. A tool the model names anyway still goes through
//     executeTool (lib/chat/tool-exec.ts) and is refused there.
//   * Every tool_use gets a tool_result back — results, errors, denials,
//     invalid input (lib/llm/tool-input.ts) and "awaiting confirmation".
//   * Confirmation gate + per-agent auto-approve: executeTool. A turn that
//     raised a proposal ends there and waits for the user's "yes".
//   * Stop: checked before every model call and every tool call; the run's
//     abort signal goes into chat(), so a model call in flight ends at once.
//   * Limits: steps, wall-clock time and cost (micro-USD from the Phase 7
//     pricing), env-configurable (loopLimitsFromEnv) — never a fixed 6.
//   * Stop reasons: tool_use → run tools; pause_turn → resume (server tools);
//     max_tokens → continue once with a note; refusal → surface it, run
//     nothing; context window → compact and retry.
//   * Prompt caching: the system prompt and the tool list are stable for the
//     whole run (one breakpoint caches both) and the conversation tail is
//     cached too. Adaptive thinking on every agent workload; effort comes from
//     the workload (lib/llm/router.ts WORKLOAD_EFFORT).
//   * Compaction: server-side where the model offers it (Anthropic compaction
//     beta — Opus 5.5 / Opus 5, see lib/llm/anthropic.ts); otherwise, when a
//     call's input passes AGENT_COMPACT_AT_TOKENS, the loop summarises the
//     run so far client-side into ONE user message (a form that stays valid
//     for models that check preserved thinking).
//   * Durability: the state is saved after every model call and every tool
//     call (lib/agents/runs/transcript.ts). A resumed run continues from the
//     last saved point and never re-runs a tool whose result was saved; a
//     non-safe tool that had started but whose result was not saved is NOT
//     re-run (at-most-once) — the model is told it was interrupted.
//   * Events: text is streamed to the run timeline as `text` events (chunks
//     of deltas, what the AG-UI SSE route replays live), tool start / result
//     as `agui` events, usage by the provider (lib/llm/usage.ts).
//   * Code mode: mode "build" runs on the `code` workload; after two tool
//     results flagged details.testsFailed === true the next call escalates to
//     `code_max`.

import type { WorkspaceRole } from "@prisma/client";
import {
  getLlmProviderFor,
  WORKLOAD_MAX_TOKENS,
  workloadForAgent,
  type LlmWorkload,
} from "@/lib/llm/router";
import { invalidToolResult } from "@/lib/llm/tool-input";
import type {
  ChatContentBlock,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStopReason,
  ChatToolResultBlock,
  ChatToolUseBlock,
  LlmProvider,
} from "@/lib/llm/types";
import { allTools, getTool, toolGroup, type ToolResult } from "@/lib/chat/tools";
import {
  DELEGATE_TOOL,
  executeTool,
  proposalText,
  runEvent,
  stopRequested,
  type ChatToolCall,
  type LoopContext,
} from "@/lib/chat/tool-exec";
import { buildLoopTools, type ConnectorChatTool, type LoopToolSet } from "./loop-tools";
import { appendAgentRunEvent } from "./runs/service";
import { isLeaseLost, isRunStopped } from "./runs/abort";
import { prismaTranscriptStore, type TranscriptStore } from "./runs/transcript";
import type { AgentKey } from "./grants";

export type { LoopContext } from "@/lib/chat/tool-exec";

// ── limits ──────────────────────────────────────────────────────────────────

type EnvLike = Record<string, string | undefined>;

export interface AgentLoopLimits {
  /** Model calls per run. */
  maxSteps: number;
  /** Wall-clock time per run (from its first step, across resumes). */
  maxMs: number;
  /** Estimated model cost per run, micro-USD (1 USD = 1,000,000). */
  maxCostMicroUsd: number;
  /** Input tokens of one call above which the loop compacts client-side. */
  compactAtTokens: number;
  /** Characters of one tool result sent back to the model. */
  toolResultMaxChars: number;
}

export const DEFAULT_LOOP_LIMITS: Readonly<AgentLoopLimits> = Object.freeze({
  maxSteps: 40,
  maxMs: 30 * 60_000,
  maxCostMicroUsd: 10_000_000,
  compactAtTokens: 150_000,
  toolResultMaxChars: 20_000,
});

function posInt(v: string | undefined): number | null {
  const n = Number((v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Limits from the environment (documented in .env.example):
 *   AGENT_MAX_STEPS (40) · AGENT_MAX_RUN_MINUTES (30) ·
 *   AGENT_MAX_RUN_COST_MICRO_USD (10000000 = $10) ·
 *   AGENT_COMPACT_AT_TOKENS (150000) · AGENT_TOOL_RESULT_MAX_CHARS (20000)
 */
export function loopLimitsFromEnv(env: EnvLike = process.env): AgentLoopLimits {
  const minutes = posInt(env.AGENT_MAX_RUN_MINUTES);
  return {
    maxSteps: posInt(env.AGENT_MAX_STEPS) ?? DEFAULT_LOOP_LIMITS.maxSteps,
    maxMs: minutes ? minutes * 60_000 : DEFAULT_LOOP_LIMITS.maxMs,
    maxCostMicroUsd: posInt(env.AGENT_MAX_RUN_COST_MICRO_USD) ?? DEFAULT_LOOP_LIMITS.maxCostMicroUsd,
    compactAtTokens: posInt(env.AGENT_COMPACT_AT_TOKENS) ?? DEFAULT_LOOP_LIMITS.compactAtTokens,
    toolResultMaxChars: posInt(env.AGENT_TOOL_RESULT_MAX_CHARS) ?? DEFAULT_LOOP_LIMITS.toolResultMaxChars,
  };
}

/** Consecutive pause_turn resumes before the loop gives up on a turn. */
const MAX_PAUSE_RESUMES = 5;
/** Client-side compactions per run (a context-window error retries after one). */
const MAX_COMPACTIONS = 4;
/** Test-fail cycles before code mode escalates to code_max. */
export const ESCALATE_AFTER_TEST_FAILURES = 2;

export const STOPPED_TEXT = "Stopped. Nothing else will run for this task.";
export const MAX_TOKENS_NOTE =
  "Your last reply was cut off at the output-token limit. Continue exactly where you stopped; do not repeat what you already wrote.";

// ── state ───────────────────────────────────────────────────────────────────

export type LoopStatus =
  | "done"
  | "awaiting_confirmation"
  | "cancelled"
  | "refused"
  | "capped"
  | "handoff"
  | "error";

export interface LoopOutcome {
  status: LoopStatus;
  finalText: string;
  proposal: ChatToolCall | null;
  cap?: "steps" | "time" | "cost";
  stopReason?: ChatStopReason;
}

/** What the loop saves after every step (versioned; lib/agents/runs/transcript.ts). */
export interface LoopState {
  v: 1;
  system: string;
  mode: "build" | "default";
  workload: LlmWorkload;
  messages: ChatMessage[];
  steps: number;
  costMicroUsd: number;
  unpricedCalls: number;
  startedAt: number;
  calls: ChatToolCall[];
  /** tool_use id → the tool_result already produced (never re-run). */
  toolResults: Record<string, ChatToolResultBlock>;
  /** tool_use ids of non-safe tools that started (at-most-once on resume). */
  toolStarted: string[];
  testFailCycles: number;
  escalated: boolean;
  maxTokensContinued: boolean;
  pauseResumes: number;
  compactions: number;
  /** Input tokens (all classes) of the last model call. */
  lastInputTokens: number;
  lastServerCompaction: boolean;
  /** Set once the run is over (a resumed finished run returns it as is). */
  outcome?: LoopOutcome;
}

export function isLoopState(v: unknown): v is LoopState {
  const s = v as Partial<LoopState> | null;
  return !!s && typeof s === "object" && s.v === 1 && Array.isArray(s.messages) && typeof s.system === "string";
}

export function initialLoopState(input: {
  system: string;
  messages: ChatMessage[];
  mode?: "build" | "default";
  workload: LlmWorkload;
  now?: number;
}): LoopState {
  return {
    v: 1,
    system: input.system,
    mode: input.mode ?? "default",
    workload: input.workload,
    messages: input.messages,
    steps: 0,
    costMicroUsd: 0,
    unpricedCalls: 0,
    startedAt: input.now ?? Date.now(),
    calls: [],
    toolResults: {},
    toolStarted: [],
    testFailCycles: 0,
    escalated: false,
    maxTokensContinued: false,
    pauseResumes: 0,
    compactions: 0,
    lastInputTokens: 0,
    lastServerCompaction: false,
  };
}

// ── events ──────────────────────────────────────────────────────────────────

export type LoopEvent =
  | { type: "text_delta"; step: number; text: string }
  | { type: "tool_start"; toolUseId: string; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; tool: string; status: ChatToolCall["status"]; summary: string }
  | { type: "step"; step: number; stopReason: ChatStopReason; model: string; costMicroUsd: number | null };

/** A banned-phrase guard for streamed text (style rules, Phase 13B). */
export type StreamGuard = (textSoFar: string) => boolean;

// ── input / output ──────────────────────────────────────────────────────────

export interface AgentLoopDeps {
  /** Provider override (tests): one provider, or one per workload. */
  provider?: LlmProvider | ((workload: LlmWorkload) => LlmProvider);
  store?: TranscriptStore;
  now?: () => number;
  /** Connector tools to offer (default none; lib/chat/agent.ts loads them). */
  connectorTools?: readonly ConnectorChatTool[];
  /** Persist streamed text / tool events on the run (default true with a runId). */
  persistEvents?: boolean;
}

export interface AgentLoopInput {
  ctx: LoopContext;
  /** A fresh run: the system prompt and opening messages. */
  system?: string;
  messages?: ChatMessage[];
  /** A resumed run: the saved state (else the store is asked for ctx.runId). */
  state?: LoopState | null;
  /** "build" routes the Operator to the code workload. */
  mode?: "build" | "default";
  limits?: Partial<AgentLoopLimits>;
  /** Epoch ms: at a step boundary after this, stop with status "handoff". */
  handoffAt?: number;
  onEvent?: (e: LoopEvent) => void;
  /** Extra stop condition checked with Stop (mission kill switches). */
  extraStopCheck?: () => Promise<string | null>;
  /** Withhold streamed text that trips a block-severity ban rule. */
  streamGuard?: StreamGuard;
  /**
   * Narrower than the grant (canonical tool names), e.g. a scheduled skill's
   * declared tools: others are hidden from the model and refused if named.
   */
  toolFilter?: (canonical: string) => boolean;
  deps?: AgentLoopDeps;
}

export interface AgentLoopResult extends LoopOutcome {
  calls: ChatToolCall[];
  state: LoopState;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function resolveProvider(deps: AgentLoopDeps | undefined, workload: LlmWorkload): LlmProvider {
  const p = deps?.provider;
  if (!p) return getLlmProviderFor(workload);
  return typeof p === "function" ? p(workload) : p;
}

export function textOf(content: readonly ChatContentBlock[]): string {
  return content
    .filter((b): b is Extract<ChatContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function isUnknownToolOnly(invalid: string): boolean {
  return /^unknown tool "/.test(invalid);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} characters]` : s;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/** The tool_result content the model sees for one call. */
export function toolResultFor(
  toolUseId: string,
  call: ChatToolCall,
  result: ToolResult | null,
  maxChars: number,
): ChatToolResultBlock {
  let content: string;
  switch (call.status) {
    case "executed": {
      let details = result?.details;
      if (call.tool === DELEGATE_TOOL && details && typeof details === "object") {
        // The sub-agent's own calls are on the call record; the model gets its report.
        const rest = { ...(details as Record<string, unknown>) };
        delete rest.calls;
        details = rest;
      }
      const json = details === undefined ? "" : safeJson(details);
      content = json ? `${call.resultSummary ?? ""}\n\n${json}` : call.resultSummary ?? "Done.";
      break;
    }
    case "pending_confirmation":
      content = `Not run: ${call.tool} is waiting for the user's OK. Don't call it again; the user has been asked to confirm.`;
      break;
    case "denied":
      content = `Refused: ${call.resultSummary ?? "outside this task's tools"}`;
      break;
    default:
      content = call.resultSummary ?? call.status;
  }
  const isError = call.status !== "executed" && call.status !== "pending_confirmation";
  return { type: "tool_result", toolUseId, content: truncate(content, maxChars), ...(isError ? { isError: true } : {}) };
}

/** Drop provider thinking blocks (a model switch can't replay another model's signatures). */
function stripThinking(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    typeof m.content === "string"
      ? m
      : { ...m, content: m.content.filter((b) => !(b.type === "opaque" && (b.kind === "thinking" || b.kind === "redacted_thinking"))) },
  );
}

function testsFailed(result: ToolResult | null): boolean {
  const d = result?.details as { testsFailed?: unknown } | undefined;
  return !!d && typeof d === "object" && d.testsFailed === true;
}

/**
 * Streamed text → run events, in order, in chunks (not one row per token).
 * A chunk is written when ~200 characters have gathered or 250 ms passed,
 * and at every step boundary. A stream guard that trips withholds the rest
 * of the step's text (the final text is enforced again before delivery).
 */
class TextEventWriter {
  private buf = "";
  private acc = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  withheld = false;

  constructor(
    private readonly ctx: LoopContext,
    private readonly step: number,
    private readonly persist: boolean,
    private readonly guard: StreamGuard | undefined,
    private readonly onEvent: ((e: LoopEvent) => void) | undefined,
  ) {}

  push(delta: string): void {
    if (this.withheld || !delta) return;
    this.acc += delta;
    if (this.guard && this.guard(this.acc)) {
      this.withheld = true;
      this.buf = "";
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    this.onEvent?.({ type: "text_delta", step: this.step, text: delta });
    if (!this.persist) return;
    this.buf += delta;
    if (this.buf.length >= 200) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 250);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const text = this.buf;
    this.buf = "";
    if (!text || !this.ctx.runId) return;
    const { workspaceId, runId } = this.ctx;
    const step = this.step;
    this.chain = this.chain.then(() =>
      appendAgentRunEvent(workspaceId, runId!, {
        type: "text",
        summary: text.trim().slice(0, 120) || "…",
        payload: { kind: "text_delta", step, text },
      }).catch(() => undefined),
    );
  }

  async close(): Promise<void> {
    this.flush();
    await this.chain;
  }
}

/** One model call, streamed: text deltas go to the writer; returns the final response. */
async function callModel(provider: LlmProvider, req: ChatRequest, writer: TextEventWriter): Promise<ChatResponse> {
  let final: ChatResponse | null = null;
  for await (const ev of provider.chatStream(req)) {
    if (ev.type === "text_delta") writer.push(ev.text);
    else if (ev.type === "final") final = ev.response;
  }
  if (!final) throw new Error("The model stream ended without a final response.");
  return final;
}

const COMPACT_INSTRUCTION = [
  "Pause the task. Write a compact summary of the work so far for your own later use:",
  "the goal, what you found (keep exact names, numbers, ids, file paths and URLs),",
  "what you did and its results, what failed, and the next steps. Do not call tools.",
].join(" ");

// ── the loop ────────────────────────────────────────────────────────────────

/** Run (or resume) the agent loop until it answers, asks, stops or hits a limit. */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { ctx } = input;
  const deps = input.deps ?? {};
  const store = deps.store ?? prismaTranscriptStore;
  const now = deps.now ?? Date.now;
  const limits: AgentLoopLimits = { ...loopLimitsFromEnv(), ...(input.limits ?? {}) };
  const persistEvents = deps.persistEvents ?? true;
  const agentKey: AgentKey = ctx.agentKey ?? "lead";

  // Fresh or resumed state.
  let state: LoopState | null = input.state ?? null;
  if (!state && ctx.runId && !input.system) {
    const saved = await store.load(ctx.workspaceId, ctx.runId).catch(() => null);
    state = isLoopState(saved) ? saved : null;
  }
  if (!state) {
    if (input.system === undefined || !input.messages) throw new Error("runAgentLoop: a fresh run needs system and messages");
    state = initialLoopState({
      system: input.system,
      messages: input.messages,
      mode: input.mode,
      workload: workloadForAgent(agentKey, { mode: input.mode }),
      now: now(),
    });
  }
  const s = state;
  if (s.outcome) return { ...s.outcome, calls: s.calls, state: s };

  const save = async () => {
    if (!ctx.runId) return;
    await store.save(ctx.workspaceId, ctx.runId, s, s.steps).catch((err) => {
      console.warn(`[agent-loop] could not save the transcript of run ${ctx.runId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const finish = async (outcome: LoopOutcome): Promise<AgentLoopResult> => {
    // A worker that lost its lease stops here WITHOUT finishing the run:
    // whoever owns the run now continues from the saved state.
    if (outcome.status === "cancelled" && isLeaseLost(ctx.signal)) outcome = { status: "handoff", finalText: "", proposal: null };
    if (outcome.status !== "handoff") s.outcome = outcome;
    await save();
    return { ...outcome, calls: s.calls, state: s };
  };
  const note = (summary: string, payload?: Record<string, unknown>) =>
    persistEvents ? runEvent(ctx, summary, payload, "note") : Promise.resolve();

  const tools: LoopToolSet = buildLoopTools({
    tools: allTools(),
    grant: ctx.grant ?? null,
    groupOf: toolGroup,
    connectorTools: deps.connectorTools,
    filter: input.toolFilter,
  });

  const stopCheck = async (): Promise<string | null> => {
    if (await stopRequested(ctx)) return STOPPED_TEXT;
    if (input.extraStopCheck) return input.extraStopCheck();
    return null;
  };

  let lastText = "";

  // Resumed between a model call and its tool results: run the tools that
  // have no saved result yet (the saved ones are reused, never re-run).
  const lastMsg = s.messages[s.messages.length - 1];
  if (lastMsg?.role === "assistant" && typeof lastMsg.content !== "string") {
    const pending = lastMsg.content.filter((b): b is ChatToolUseBlock => b.type === "tool_use");
    if (pending.length > 0) {
      const tr = await runToolStep(s, pending, tools, ctx, input, limits, persistEvents);
      if (tr.cancelled) return finish({ status: "cancelled", finalText: STOPPED_TEXT, proposal: null });
      if (tr.proposal) {
        return finish({ status: "awaiting_confirmation", finalText: proposalText(tr.proposal), proposal: tr.proposal });
      }
    }
  }

  for (;;) {
    // ── before every model call: Stop, limits, hand-off ─────────────────────
    const stopped = await stopCheck();
    if (stopped) return finish({ status: "cancelled", finalText: stopped, proposal: null });

    const elapsed = now() - s.startedAt;
    const cap: "steps" | "time" | "cost" | null =
      s.steps >= limits.maxSteps
        ? "steps"
        : elapsed >= limits.maxMs || (ctx.deadlineAt !== undefined && now() >= ctx.deadlineAt)
          ? "time"
          : s.costMicroUsd >= Math.min(limits.maxCostMicroUsd, ctx.costLeftMicroUsd ?? Infinity)
            ? "cost"
            : null;
    if (cap) {
      const why =
        cap === "steps"
          ? `its step limit (${limits.maxSteps} model calls)`
          : cap === "time"
            ? `its time limit (${Math.round(limits.maxMs / 60_000)} minutes)`
            : `its cost limit (≈$${(limits.maxCostMicroUsd / 1_000_000).toFixed(2)})`;
      await note(`Stopped at ${why}`, { kind: "cap", cap });
      const text = [lastText, `I stopped here: this task reached ${why}. Ask me to continue if you want more.`]
        .filter(Boolean)
        .join("\n\n");
      return finish({ status: "capped", finalText: text, proposal: null, cap });
    }
    if (input.handoffAt !== undefined && s.steps > 0 && now() >= input.handoffAt) {
      await save();
      return { status: "handoff", finalText: "", proposal: null, calls: s.calls, state: s };
    }

    // ── client-side compaction ───────────────────────────────────────────────
    const provider = resolveProvider(deps, s.workload);
    if (!s.lastServerCompaction && s.lastInputTokens >= limits.compactAtTokens && s.compactions < MAX_COMPACTIONS) {
      await compactClientSide(s, provider, tools, ctx);
      await note(`Compacted the conversation (${s.compactions})`, { kind: "compaction", mode: "client" });
      await save();
    }

    // ── the model call ───────────────────────────────────────────────────────
    const req: ChatRequest = {
      system: [{ text: s.system, cache: true }],
      // A snapshot: the transcript grows after the call.
      messages: [...s.messages],
      tools: tools.defs,
      serverTools: tools.serverTools,
      maxTokens: WORKLOAD_MAX_TOKENS[s.workload],
      thinking: "adaptive",
      cache: true,
      cacheConversation: true,
      compaction: true,
      signal: ctx.signal,
      usage: {
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId || null,
        actorId: ctx.userId || null,
        runId: ctx.runId ?? null,
        agentKey,
      },
    };
    const step = s.steps + 1;
    const writer = new TextEventWriter(ctx, step, persistEvents && !!ctx.runId, input.streamGuard, input.onEvent);
    let res: ChatResponse;
    try {
      res = await callModel(provider, req, writer);
    } catch (err) {
      await writer.close();
      if (isRunStopped(err) || ctx.signal?.aborted) {
        return finish({ status: "cancelled", finalText: STOPPED_TEXT, proposal: null });
      }
      const msg = err instanceof Error ? err.message : "unknown error";
      if (/context|too long|prompt is too long/i.test(msg) && s.compactions < MAX_COMPACTIONS && s.messages.length > 1) {
        // A context-window rejection: compact and try again.
        await compactClientSide(s, provider, tools, ctx).catch(() => undefined);
        await save();
        continue;
      }
      await note(`Model call failed: ${msg}`, { kind: "error" });
      return finish({
        status: "error",
        finalText: `The AI provider failed: ${msg}. Try again in a moment.`,
        proposal: null,
      });
    }
    await writer.close();

    s.steps = step;
    if (res.costMicroUsd === null) s.unpricedCalls++;
    else s.costMicroUsd += res.costMicroUsd;
    s.lastInputTokens = res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens;
    s.lastServerCompaction = res.meta.compaction === "server";
    input.onEvent?.({ type: "step", step, stopReason: res.stopReason, model: res.model, costMicroUsd: res.costMicroUsd });
    if (res.content.length > 0) s.messages.push({ role: "assistant", content: res.content });
    const text = textOf(res.content);
    if (text) lastText = text;
    if (res.stopReason !== "pause_turn") s.pauseResumes = 0;
    await save();

    const toolUses = res.content.filter((b): b is ChatToolUseBlock => b.type === "tool_use");

    // ── stop reasons ─────────────────────────────────────────────────────────
    if (res.stopReason === "refusal") {
      const why = res.stopDetails?.explanation ? ` (${res.stopDetails.explanation})` : "";
      await note(`The model declined${why}`, { kind: "refusal", category: res.stopDetails?.category ?? null });
      return finish({
        status: "refused",
        finalText: [text, `The model declined to continue with this request${why}. Nothing else was run.`].filter(Boolean).join("\n\n"),
        proposal: null,
        stopReason: "refusal",
      });
    }
    if (res.stopReason === "pause_turn") {
      // A long server-tool turn paused: send it back as is (no extra user
      // message — the API resumes from the trailing server_tool_use block).
      s.pauseResumes++;
      if (s.pauseResumes > MAX_PAUSE_RESUMES) {
        return finish({ status: "done", finalText: text || lastText, proposal: null, stopReason: "pause_turn" });
      }
      await save();
      continue;
    }
    if (res.stopReason === "max_tokens" || res.stopReason === "context_window_exceeded") {
      // Tool calls of a cut-off turn are never run; each gets an error result.
      const results = toolUses.map((b) => invalidToolResult(b));
      if (res.stopReason === "context_window_exceeded" && s.compactions < MAX_COMPACTIONS) {
        if (results.length) s.messages.push({ role: "user", content: results });
        await compactClientSide(s, provider, tools, ctx).catch(() => undefined);
        await save();
        continue;
      }
      if (!s.maxTokensContinued) {
        s.maxTokensContinued = true;
        s.messages.push({ role: "user", content: [...results, { type: "text", text: MAX_TOKENS_NOTE }] });
        await note("Reply cut off at the output limit; continuing once", { kind: "max_tokens" });
        await save();
        continue;
      }
      return finish({
        status: "done",
        finalText: [text || lastText, "(The reply was cut off at the output limit.)"].filter(Boolean).join("\n\n"),
        proposal: null,
        stopReason: res.stopReason,
      });
    }
    if (toolUses.length === 0) {
      return finish({ status: "done", finalText: text, proposal: null, stopReason: res.stopReason });
    }

    // ── tools ────────────────────────────────────────────────────────────────
    const tr = await runToolStep(s, toolUses, tools, ctx, input, limits, persistEvents);
    if (tr.cancelled) return finish({ status: "cancelled", finalText: STOPPED_TEXT, proposal: null });
    if (tr.proposal) {
      return finish({ status: "awaiting_confirmation", finalText: proposalText(tr.proposal), proposal: tr.proposal });
    }
    // Code mode: escalate after repeated failing test cycles.
    if (s.mode === "build" && s.workload === "code" && !s.escalated && s.testFailCycles >= ESCALATE_AFTER_TEST_FAILURES) {
      s.escalated = true;
      s.workload = "code_max";
      s.messages = stripThinking(s.messages);
      await note(`Tests failed ${s.testFailCycles} times: escalating to the code_max model`, { kind: "escalation", workload: "code_max" });
      await save();
    }
  }
}

/** Run one step's tool calls; append their results as one user message. */
async function runToolStep(
  s: LoopState,
  toolUses: ChatToolUseBlock[],
  tools: LoopToolSet,
  ctx: LoopContext,
  input: AgentLoopInput,
  limits: AgentLoopLimits,
  persistEvents: boolean,
): Promise<{ cancelled: boolean; proposal: ChatToolCall | null }> {
  const store = input.deps?.store ?? prismaTranscriptStore;
  const save = () =>
    ctx.runId ? store.save(ctx.workspaceId, ctx.runId, s, s.steps).catch(() => undefined) : Promise.resolve();
  const results: ChatToolResultBlock[] = [];
  const stepCalls: ChatToolCall[] = [];
  let proposal: ChatToolCall | null = null;
  let failedTests = false;

  for (const block of toolUses) {
    const saved = s.toolResults[block.id];
    if (saved) {
      // Resumed after a crash: this call already ran — never again.
      results.push(saved);
      continue;
    }
    const canonical = tools.toCanonical(block.name);
    const call: ChatToolCall = { tool: canonical, args: block.input ?? {}, status: "executed", toolUseId: block.id };
    if (ctx.runId) call.runId = ctx.runId;

    let result: ToolResult | null = null;
    if (block.invalid && !isUnknownToolOnly(block.invalid)) {
      // Unparseable / schema-invalid input: never run; tell the model why.
      call.status = "error";
      call.resultSummary = `Invalid input for ${canonical}: ${block.invalid}`;
      const r = invalidToolResult(block);
      s.toolResults[block.id] = r;
      results.push(r);
      s.calls.push(call);
      stepCalls.push(call);
      await save();
      continue;
    }
    const def = getTool(canonical);
    const sideEffects = !def || def.kind !== "safe";
    if (input.toolFilter && !input.toolFilter(canonical)) {
      // Outside the run's narrower allow-list: refused like an ungranted tool.
      call.status = "denied";
      call.resultSummary = `This run may not use ${canonical} (not in its declared tools).`;
      await runEvent(ctx, `Refused ${canonical}: not in this run's declared tools`, { kind: "tool_result", tool: canonical, status: "denied", toolUseId: block.id }, "gate");
    } else if (sideEffects && s.toolStarted.includes(block.id)) {
      // Started before a crash, result never saved: may or may not have run.
      call.status = "error";
      call.resultSummary = `${canonical} was interrupted (the worker restarted) and was not run again; it may or may not have completed. Check before retrying.`;
    } else {
      if (await stopRequested(ctx)) {
        call.status = "cancelled";
        call.resultSummary = "Not run — the task was stopped.";
        s.calls.push(call);
        await save();
        return { cancelled: true, proposal: null };
      }
      if (sideEffects) {
        s.toolStarted.push(block.id);
        await save();
      }
      input.onEvent?.({ type: "tool_start", toolUseId: block.id, tool: canonical, args: call.args });
      if (persistEvents) {
        await runEvent(ctx, `Calling ${canonical}`, { kind: "tool_start", toolUseId: block.id, tool: canonical, args: call.args });
      }
      // The run's remaining budget rides along (a delegated child stays inside it).
      const toolCtx: LoopContext = {
        ...ctx,
        toolUseId: block.id,
        deadlineAt: Math.min(ctx.deadlineAt ?? Infinity, s.startedAt + limits.maxMs),
        costLeftMicroUsd: Math.max(0, Math.min(ctx.costLeftMicroUsd ?? Infinity, limits.maxCostMicroUsd) - s.costMicroUsd),
      };
      result = await executeTool(toolCtx, canonical, call.args, call);
      if (call.status === "cancelled") {
        s.calls.push(call);
        await save();
        return { cancelled: true, proposal: null };
      }
      // A delegated sub-agent's spend counts against this run's budget.
      const childCost = (result?.details as { costMicroUsd?: unknown } | undefined)?.costMicroUsd;
      if (typeof childCost === "number" && Number.isFinite(childCost)) s.costMicroUsd += childCost;
      if (testsFailed(result)) failedTests = true;
    }
    const r = toolResultFor(block.id, call, result, limits.toolResultMaxChars);
    s.toolResults[block.id] = r;
    results.push(r);
    s.calls.push(call);
    stepCalls.push(call);
    input.onEvent?.({ type: "tool_result", toolUseId: block.id, tool: canonical, status: call.status, summary: call.resultSummary ?? "" });
    if (call.status === "pending_confirmation" && !proposal) proposal = call;
    const sub = call.delegated?.find((c) => c.status === "pending_confirmation");
    if (sub && !proposal) proposal = sub;
    await save();
  }

  if (failedTests) s.testFailCycles++;
  s.messages.push({ role: "user", content: results });

  if (proposal) {
    // Propose the FIRST pending action and stop; drop the rest so nothing
    // leaks through a later "yes".
    for (const c of stepCalls) {
      if (c.status === "pending_confirmation" && c !== proposal) c.status = "error";
      for (const d of c.delegated ?? []) if (d.status === "pending_confirmation" && d !== proposal) d.status = "error";
    }
    // A sub-agent's proposal is lifted to the top level so the user's "yes"
    // finds it (the chat reads top-level calls only).
    if (!s.calls.includes(proposal)) s.calls.push(proposal);
  }
  await save();
  return { cancelled: false, proposal };
}

/**
 * Client-side compaction: ask the same model (same system + tools, so the
 * cached prefix is reused) to summarise the run, then replace the whole
 * transcript with ONE user message — the opening request plus the summary.
 */
async function compactClientSide(s: LoopState, provider: LlmProvider, tools: LoopToolSet, ctx: LoopContext): Promise<void> {
  const opening = s.messages[0];
  const openingText =
    typeof opening?.content === "string"
      ? opening.content
      : (opening?.content ?? [])
          .filter((b): b is Extract<ChatContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n");
  const last = s.messages[s.messages.length - 1];
  const tail: ChatMessage =
    last?.role === "user"
      ? { role: "user", content: [...(typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content), { type: "text", text: COMPACT_INSTRUCTION }] }
      : { role: "user", content: COMPACT_INSTRUCTION };
  const messages = last?.role === "user" ? [...s.messages.slice(0, -1), tail] : [...s.messages, tail];
  const res = await provider.chat({
    system: [{ text: s.system, cache: true }],
    messages,
    tools: tools.defs,
    maxTokens: 8192,
    toolChoice: "none",
    cache: true,
    signal: ctx.signal,
    usage: { workspaceId: ctx.workspaceId, projectId: ctx.projectId || null, actorId: ctx.userId || null, runId: ctx.runId ?? null, agentKey: ctx.agentKey ?? "lead" },
  });
  if (res.costMicroUsd === null) s.unpricedCalls++;
  else s.costMicroUsd += res.costMicroUsd;
  const summary = textOf(res.content) || "(no summary was produced)";
  s.messages = [
    {
      role: "user",
      content: `${openingText}\n\n## Progress so far (the earlier conversation was compacted)\n\n${summary}\n\nContinue the task from here.`,
    },
  ];
  s.compactions++;
  s.lastInputTokens = 0;
}

// ── role helpers used by the callers ────────────────────────────────────────

/** Role for a run that has no person behind it (mission, scheduler). */
export const SYSTEM_RUN_ROLE: WorkspaceRole = "editor";
