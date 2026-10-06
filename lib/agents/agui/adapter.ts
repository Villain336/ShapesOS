// Marketr — Phase 16 slice 1: AG-UI adapter for the chat agent.
//
// Phase 8: LIVE streaming. The turn runs as a tracked AgentRun on the native
// agent loop (lib/agents/loop.ts), which writes streamed model text (`text`
// events, chunks of real deltas) and tool start / result events to the run
// timeline as they happen. The adapter tails that timeline while the turn
// works — in this process or, after a hand-off, on the agent worker — and
// maps each event to AG-UI as it lands:
//
//   text_delta  → TEXT_MESSAGE_START (per model step) / TEXT_MESSAGE_CONTENT
//   tool_start  → TOOL_CALL_START → TOOL_CALL_ARGS → TOOL_CALL_END
//   tool_result → TOOL_CALL_RESULT (+ CUSTOM marketr.toolProposal when held)
//
// The final text (after style-rule enforcement, a proposal, a cap note) is
// reconciled at the end: appended to the open message when it extends what
// streamed, otherwise sent as its own message. A turn handed to the worker
// emits CUSTOM marketr.queued and the stream keeps going until the run ends.
//
// Legacy replay (an injected deps.runTurn, used by the contract tests):
// the adapter buffers the finished turn and emits the
// protocol-ordered sequence:
//
//   RUN_STARTED
//     (per tool call, in turn order)
//     TOOL_CALL_START → TOOL_CALL_ARGS → TOOL_CALL_END → TOOL_CALL_RESULT
//     (+ CUSTOM "marketr.toolProposal" when a call is held behind the
//        confirmation gate — the HITL plug-in point for a later slice)
//   TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT* → TEXT_MESSAGE_END
//   RUN_FINISHED | RUN_ERROR
//
// This is an ADAPTER, not a rewrite: lib/chat/agent.ts is untouched, and
// runAgentTurnWithCapture stays the single turn-execution path (including
// the Phase 13B episode capture).
//
// Orchestrator plug-in point: AguiEmitter below is the sink future
// orchestrator/mission emitters build on (STEP_*, STATE_SNAPSHOT/DELTA,
// SUBAGENT_*). This slice ships the emitter and context factory; mission
// events arrive in a later slice.

import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  EventType,
  MARKETR_CUSTOM_NAMES,
  withRunMeta,
  type AguiEvent,
  type AguiRunMeta,
  type JsonPatch,
  type TextMessageContentEvent,
  type ToolCallArgsEvent,
} from "./events";
import { createAguiLogger } from "./logger";
import { mergeSharedState, type SharedAgentState } from "./shared-state";
import { sseResponse, type SseOptions } from "@/lib/http/sse";
import type { AppliedStateChange } from "./shared-state-db";
import type { WorkspaceRole } from "@prisma/client";
import type { AgentTurnInput, AgentTurnOutput, ChatToolCall } from "@/lib/chat/agent";

/** What the adapter needs from the caller (mirrors AgentTurnInput + run ids). */
export interface AguiTurnRequest {
  projectId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  threadId: string;
  userContent: string;
  attachmentIds?: string[];
  /** Client-supplied run id (e.g. for resumability); generated when absent. */
  runId?: string;
  /**
   * Frontend CopilotKit state carried in with the run (the UI→agent half of
   * CoAgents shared state — @ag-ui/client sends agent.state on every run).
   * The adapter diffs it against the DB baseline and persists what the UI
   * is allowed to change (content-calendar rows); the canonical snapshot
   * is then re-emitted so the agent sees the applied result.
   */
  incomingState?: SharedAgentState;
}

/** Context passed to the shared-state loaders/applier. */
export interface SharedStateContext {
  workspaceId: string;
  projectId: string;
}

/** A run timeline row as the tailer reads it (lib/agents/runs/service.ts). */
export interface TailedRunEvent {
  seq: number;
  type: string;
  summary: string;
  payload: unknown;
}

export interface AguiAdapterDeps {
  /**
   * Injectable turn executor (legacy replay: the finished turn is replayed).
   * When omitted the turn runs tracked and is streamed live from its run.
   */
  runTurn?: (input: AgentTurnInput) => Promise<AgentTurnOutput>;
  /** Phase 8: the tracked turn (default lib/chat/agent.ts runTrackedAgentTurn). */
  runTrackedTurn?: (
    input: AgentTurnInput,
    opts: { onRunCreated: (runId: string) => void },
  ) => Promise<AgentTurnOutput & { runId: string }>;
  /** Phase 8: the run's events after a seq (default: the run service). */
  listRunEvents?: (workspaceId: string, runId: string, afterSeq: number) => Promise<TailedRunEvent[]>;
  /** Phase 8: the run's status (null when gone). */
  getRunStatus?: (workspaceId: string, runId: string) => Promise<string | null>;
  /** Phase 8: the latest assistant message of the thread (a queued turn's answer). */
  latestAssistantText?: (threadId: string) => Promise<string | null>;
  /** Phase 8: tail interval (default 200 ms) and cap on one stream (default 30 min). */
  pollMs?: number;
  maxStreamMs?: number;
  /**
   * Deploy PR: told the run cursor (agent run id + timeline seq) before each
   * run event is mapped — the SSE route stamps it as the event id, so a
   * client can resume after that event (Last-Event-ID).
   */
  onCursor?: (agentRunId: string, seq: number) => void;
  /**
   * Deploy PR: true while this server drains. A tailing stream then ends at a
   * clean boundary with CUSTOM marketr.reconnect { runId, after, aguiRunId }
   * instead of waiting for the run (which the worker carries on).
   */
  shouldReconnect?: () => boolean;
  /** Injectable run-id factory (tests pin it). */
  newRunId?: () => string;
  /** Text chunker for TEXT_MESSAGE_CONTENT deltas. */
  chunkText?: (text: string) => string[];
  /** Log-line sink (defaults to structured console lines). */
  logSink?: (line: string) => void;
  /**
   * Load the three shared-state domains (calendar, mission, approvals).
   * Defaults to the prisma-backed loaders in ./shared-state-db (lazy
   * import, same as runTurn, so tests never load prisma). Omit to skip
   * the STATE_SNAPSHOT (e.g. surfaces without shared state).
   */
  loadSharedState?: (ctx: SharedStateContext) => Promise<SharedAgentState>;
  /**
   * Apply UI-originated state changes (calendar rows only — mission and
   * approvals are read-only through shared state). Defaults to the
   * prisma-backed applier. The adapter reloads state after applying so the
   * emitted snapshot is canonical.
   */
  applySharedStateUpdates?: (
    ctx: SharedStateContext,
    prev: SharedAgentState,
    next: SharedAgentState,
  ) => Promise<{ applied: AppliedStateChange[] }>;
}

/** Default text chunker: fixed-width slices (no tokenization dependency). */
export const DEFAULT_CONTENT_CHUNK_SIZE = 400;

export function chunkTextFixed(text: string, size = DEFAULT_CONTENT_CHUNK_SIZE): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function defaultRunTrackedTurn(
  input: AgentTurnInput,
  opts: { onRunCreated: (runId: string) => void },
): Promise<AgentTurnOutput & { runId: string }> {
  // Lazy import so loading the adapter never loads the agent (and its
  // prisma/LLM graph) — keeps the contract tests fast and side-effect free.
  // Phase 5: tracked — the turn is an AgentRun (agent, tool grant, Stop).
  return import("@/lib/chat/agent").then((m) => m.runTrackedAgentTurn(input, { onRunCreated: opts.onRunCreated }));
}

async function defaultListRunEvents(workspaceId: string, runId: string, afterSeq: number): Promise<TailedRunEvent[]> {
  const { listAgentRunEventsAfter } = await import("@/lib/agents/runs/service");
  return listAgentRunEventsAfter(workspaceId, runId, afterSeq);
}

async function defaultGetRunStatus(workspaceId: string, runId: string): Promise<string | null> {
  const { getAgentRun } = await import("@/lib/agents/runs/service");
  return (await getAgentRun(workspaceId, runId))?.status ?? null;
}

async function defaultLatestAssistantText(threadId: string): Promise<string | null> {
  const { prisma } = await import("@/lib/prisma");
  const m = await prisma.aiChatMessage.findFirst({
    where: { threadId, role: "assistant" },
    orderBy: { createdAt: "desc" },
    select: { content: true },
  });
  return m?.content ?? null;
}

function defaultLoadSharedState(ctx: SharedStateContext): Promise<SharedAgentState> {
  // Lazy for the same reason as defaultRunTurn: the DB module pulls prisma.
  return import("./shared-state-db").then((m) => m.defaultLoadSharedState(ctx));
}

function defaultApplySharedStateUpdates(
  ctx: SharedStateContext,
  prev: SharedAgentState,
  next: SharedAgentState,
): Promise<{ applied: AppliedStateChange[] }> {
  return import("./shared-state-db").then((m) =>
    m.defaultApplySharedStateUpdates(ctx, prev, next),
  );
}

function stamp<E extends AguiEvent>(event: E, meta: AguiRunMeta): E {
  return withRunMeta({ ...event, timestamp: Date.now() }, meta);
}

/**
 * Map one ChatToolCall to its AG-UI tool-call event block.
 * `pending_confirmation` calls ALSO emit a CUSTOM marketr.toolProposal event
 * carrying the proposal payload — the future HITL interrupt renderer reads
 * this; today it is informational (the gate itself stays authoritative).
 */
function* toolCallEvents(
  call: ChatToolCall,
  index: number,
  meta: AguiRunMeta,
): Generator<AguiEvent> {
  const toolCallId = `${meta.runId}:tool:${index}:${call.tool}`;
  const parentMessageId = `${meta.runId}:msg:assistant`;

  yield stamp(
    {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: call.tool,
      parentMessageId,
    },
    meta,
  );

  const argsEvent: ToolCallArgsEvent = {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta: JSON.stringify(call.args ?? {}),
  };
  yield stamp(argsEvent, meta);

  yield stamp({ type: EventType.TOOL_CALL_END, toolCallId }, meta);

  const statusMeta = { status: call.status, ...(call.confirmed ? { confirmed: true } : {}) };
  yield stamp(
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${toolCallId}:result`,
      toolCallId,
      content: call.resultSummary ?? "",
      metadata: { marketr: { ...statusMeta, runId: meta.runId } },
    },
    meta,
  );

  if (call.status === "pending_confirmation") {
    yield stamp(
      {
        type: EventType.CUSTOM,
        name: MARKETR_CUSTOM_NAMES.toolProposal,
        value: { tool: call.tool, args: call.args, toolCallId },
      },
      meta,
    );
  }
}

/**
 * Stream one chat turn as AG-UI events. Every emitted event is also logged
 * (structured, one line per event) via the run-scoped logger.
 */
export async function* streamChatTurnAgui(
  request: AguiTurnRequest,
  deps: AguiAdapterDeps = {},
): AsyncGenerator<AguiEvent> {
  const runId = request.runId ?? (deps.newRunId ?? randomUUID)();
  const meta: AguiRunMeta = { runId, threadId: request.threadId, workspaceId: request.workspaceId };
  const log = createAguiLogger(meta, deps.logSink);
  const chunkText = deps.chunkText ?? chunkTextFixed;
  const loadSharedState = deps.loadSharedState ?? defaultLoadSharedState;
  const applySharedStateUpdates = deps.applySharedStateUpdates ?? defaultApplySharedStateUpdates;

  const emit = function* (event: AguiEvent): Generator<AguiEvent> {
    log(event);
    yield event;
  };

  yield* emit(
    stamp(
      {
        type: EventType.RUN_STARTED,
        threadId: request.threadId,
        runId,
        protocolVersion: PROTOCOL_VERSION,
      },
      meta,
    ),
  );

  // CoAgents shared state (Phase 16 slice 4): emit the canonical snapshot
  // right after RUN_STARTED so the frontend's agent.state is populated
  // before any text arrives. UI→agent direction: when the client carried
  // updated state in with the run, apply the writable changes first, then
  // re-load so the snapshot (and the agent's subsequent tool calls) see
  // the canonical post-apply state. Failures here never fail the turn —
  // the agent run is more important than the snapshot.
  const stateCtx: SharedStateContext = {
    workspaceId: request.workspaceId,
    projectId: request.projectId,
  };
  try {
    const baseline = await loadSharedState(stateCtx);
    let current = baseline;
    if (request.incomingState && Object.keys(request.incomingState).length > 0) {
      const { applied } = await applySharedStateUpdates(stateCtx, baseline, request.incomingState);
      if (applied.some((a) => !a.skipped)) {
        current = await loadSharedState(stateCtx);
      } else {
        // Nothing was writable — still honor the client's view for
        // domains the baseline didn't cover (offline-first optimism).
        current = mergeSharedState(baseline, request.incomingState);
      }
    }
    yield* emit(stamp({ type: EventType.STATE_SNAPSHOT, snapshot: current }, meta));
  } catch {
    // No snapshot this turn; the chat itself still streams.
  }

  if (!deps.runTurn) {
    yield* streamLiveTurn(request, deps, meta, emit);
    return;
  }

  let output: AgentTurnOutput;
  try {
    const runTurn = deps.runTurn;
    output = await runTurn({
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      userId: request.userId,
      role: request.role,
      threadId: request.threadId,
      userContent: request.userContent,
      attachmentIds: request.attachmentIds,
    });
  } catch (err) {
    yield* emit(
      stamp(
        {
          type: EventType.RUN_ERROR,
          threadId: request.threadId,
          runId,
          message: err instanceof Error ? err.message : "Agent turn failed",
        },
        meta,
      ),
    );
    return;
  }

  // Tool calls happened before the final text in the agent loop — replay
  // them first so the stream reads like the run actually unfolded.
  for (let i = 0; i < output.toolCalls.length; i++) {
    const call = output.toolCalls[i];
    for (const e of toolCallEvents(call, i, meta)) yield* emit(e);
  }

  const messageId = `${runId}:msg:assistant`;
  yield* emit(
    stamp({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" }, meta),
  );
  for (const delta of chunkText(output.assistantText)) {
    const contentEvent: TextMessageContentEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta,
    };
    yield* emit(stamp(contentEvent, meta));
  }
  yield* emit(stamp({ type: EventType.TEXT_MESSAGE_END, messageId }, meta));

  yield* emit(
    stamp(
      {
        type: EventType.RUN_FINISHED,
        threadId: request.threadId,
        runId,
        outcome: { type: "success" },
      },
      meta,
    ),
  );
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
/**
 * Phase 16: a queued turn's tail also ends when its run waits for the user's
 * OK (sub-agents' proposals are listed in the thread) — "yes" is a new turn.
 */
const TAIL_ENDS = new Set([...TERMINAL, "awaiting_confirmation"]);

function sleepOrSettle(ms: number, settled: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    settled.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      },
    );
  });
}

/**
 * The run-timeline tail shared by a live turn (POST /api/agents/chat) and a
 * resumed one (GET /api/agents/chat/stream, deploy PR): maps run events to
 * AG-UI as they land, remembering the open message and seen tool calls.
 * Message ids derive from the AG-UI run id + agent run id + model step, so a
 * resumed stream continues the SAME messages the client already shows.
 */
function createRunTail(
  request: { workspaceId: string },
  deps: AguiAdapterDeps,
  meta: AguiRunMeta,
  emitOut: (event: AguiEvent) => Generator<AguiEvent>,
  afterSeq = -1,
) {
  const listEvents = deps.listRunEvents ?? defaultListRunEvents;
  // While priming a resumed stream (prime() below) the state is rebuilt from
  // events the client already has, so nothing is emitted.
  let silent = false;
  const emit = function* (event: AguiEvent): Generator<AguiEvent> {
    if (!silent) yield* emitOut(event);
  };
  const runIdAgui = meta.runId;
  const st = {
    agentRunId: null as string | null,
    lastSeq: afterSeq,
    openMsg: null as string | null,
    openText: "",
    seenTools: new Set<string>(),
  };

  const closeMsg = function* (): Generator<AguiEvent> {
    if (!st.openMsg) return;
    yield* emit(stamp({ type: EventType.TEXT_MESSAGE_END, messageId: st.openMsg }, meta));
    st.openMsg = null;
  };
  const mapEvent = function* (ev: TailedRunEvent): Generator<AguiEvent> {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.type === "text" && p.kind === "text_delta" && typeof p.text === "string") {
      const id = `${runIdAgui}:msg:${st.agentRunId}:${String(p.step ?? 0)}`;
      if (st.openMsg !== id) {
        yield* closeMsg();
        st.openMsg = id;
        st.openText = "";
        yield* emit(stamp({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" }, meta));
      }
      st.openText += p.text;
      yield* emit(stamp({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: p.text } as TextMessageContentEvent, meta));
      return;
    }
    const toolUseId = typeof p.toolUseId === "string" ? p.toolUseId : null;
    const tool = typeof p.tool === "string" ? p.tool : null;
    if (!toolUseId || !tool) return;
    const toolCallId = `${runIdAgui}:tool:${toolUseId}`;
    const start = function* (args: unknown): Generator<AguiEvent> {
      if (st.seenTools.has(toolCallId)) return;
      st.seenTools.add(toolCallId);
      yield* closeMsg();
      yield* emit(stamp({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: tool, parentMessageId: `${runIdAgui}:msg:assistant` }, meta));
      yield* emit(stamp({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args ?? {}) } as ToolCallArgsEvent, meta));
      yield* emit(stamp({ type: EventType.TOOL_CALL_END, toolCallId }, meta));
    };
    if (p.kind === "tool_start") {
      yield* start(p.args);
    } else if (p.kind === "tool_result") {
      yield* start({});
      const status = typeof p.status === "string" ? p.status : "executed";
      yield* emit(
        stamp(
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: `${toolCallId}:result`,
            toolCallId,
            content: typeof p.summary === "string" ? p.summary : ev.summary,
            metadata: { marketr: { status, runId: runIdAgui } },
          },
          meta,
        ),
      );
      if (status === "pending_confirmation") {
        yield* emit(stamp({ type: EventType.CUSTOM, name: MARKETR_CUSTOM_NAMES.toolProposal, value: { tool, toolCallId } }, meta));
      }
    }
  };
  const drain = async function* (): AsyncGenerator<AguiEvent> {
    if (!st.agentRunId) return;
    for (;;) {
      const batch = await listEvents(request.workspaceId, st.agentRunId, st.lastSeq).catch(() => [] as TailedRunEvent[]);
      for (const ev of batch) {
        st.lastSeq = Math.max(st.lastSeq, ev.seq);
        // Every AG-UI event derived from run event N carries cursor N.
        deps.onCursor?.(st.agentRunId, st.lastSeq);
        yield* mapEvent(ev);
      }
      if (batch.length < 500) return;
    }
  };
  /**
   * Deploy PR: a stream resumed on another replica must continue where the
   * client is, not where this process is. Replay the run's events up to
   * `upToSeq` silently, so the open message (same id, no second
   * TEXT_MESSAGE_START), the text already shown in it, and the tool calls
   * already announced are known. Without this the final reconcile saw only
   * the post-resume text and sent the whole answer again as a new message.
   */
  const prime = async (upToSeq: number): Promise<void> => {
    if (!st.agentRunId || upToSeq < 0) return;
    silent = true;
    try {
      let after = -1;
      for (;;) {
        const batch = await listEvents(request.workspaceId, st.agentRunId, after).catch(() => [] as TailedRunEvent[]);
        for (const ev of batch) {
          if (ev.seq > upToSeq) return;
          after = Math.max(after, ev.seq);
          for (const _ of mapEvent(ev)) void _;
        }
        if (batch.length < 500) return;
      }
    } finally {
      silent = false;
      st.lastSeq = Math.max(st.lastSeq, upToSeq);
    }
  };
  /** Draining: end at this clean boundary and tell the client where to resume. */
  const reconnect = function* (): Generator<AguiEvent> {
    yield* emit(
      stamp(
        {
          type: EventType.CUSTOM,
          name: MARKETR_CUSTOM_NAMES.reconnect,
          value: { runId: st.agentRunId, after: st.lastSeq, aguiRunId: runIdAgui },
        },
        meta,
      ),
    );
  };
  /** Reconcile the final (delivered) text with what streamed, then finish. */
  const finish = function* (finalText: string, threadId: string): Generator<AguiEvent> {
    const final = finalText.trim();
    if (final) {
      if (st.openMsg && final.startsWith(st.openText.trim()) && st.openText.trim()) {
        // What the client lacks after the text the open message already
        // holds. Compare exactly when possible: the trimmed comparison used
        // to re-send whitespace the stream had already delivered (the smoke
        // saw a lone " " after a resume). A whitespace-only tail adds nothing.
        const rest = finalText.startsWith(st.openText)
          ? finalText.slice(st.openText.length)
          : finalText.slice(finalText.indexOf(st.openText.trim()) + st.openText.trim().length);
        if (rest.trim()) yield* emit(stamp({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: st.openMsg, delta: rest } as TextMessageContentEvent, meta));
        yield* closeMsg();
      } else if (!st.openMsg || final !== st.openText.trim()) {
        yield* closeMsg();
        const messageId = `${runIdAgui}:msg:assistant`;
        yield* emit(stamp({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" }, meta));
        for (const delta of (deps.chunkText ?? chunkTextFixed)(finalText)) {
          yield* emit(stamp({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta } as TextMessageContentEvent, meta));
        }
        yield* emit(stamp({ type: EventType.TEXT_MESSAGE_END, messageId }, meta));
      } else {
        yield* closeMsg();
      }
    } else {
      yield* closeMsg();
    }
    yield* emit(stamp({ type: EventType.RUN_FINISHED, threadId, runId: runIdAgui, outcome: { type: "success" } }, meta));
  };
  /**
   * Tail a run the worker carries until it ends (or waits for the user), or
   * until this server drains. Returns "stopped" when it ended for the drain.
   */
  const tailUntilEnd = async function* (deadline: number): AsyncGenerator<AguiEvent, "ended" | "stopped"> {
    const getStatus = deps.getRunStatus ?? defaultGetRunStatus;
    const pollMs = deps.pollMs ?? 200;
    for (;;) {
      yield* drain();
      if (deps.shouldReconnect?.()) return "stopped";
      const status = st.agentRunId ? await getStatus(request.workspaceId, st.agentRunId).catch(() => null) : null;
      if (!status || TAIL_ENDS.has(status) || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.max(pollMs, 500)));
    }
    yield* drain();
    return "ended";
  };
  return { st, closeMsg, drain, prime, reconnect, finish, tailUntilEnd };
}

/**
 * Phase 8: run the turn tracked and stream it from its run timeline as it
 * happens (see the header). Never throws: a failure is RUN_ERROR.
 */
async function* streamLiveTurn(
  request: AguiTurnRequest,
  deps: AguiAdapterDeps,
  meta: AguiRunMeta,
  emit: (event: AguiEvent) => Generator<AguiEvent>,
): AsyncGenerator<AguiEvent> {
  const runTracked = deps.runTrackedTurn ?? defaultRunTrackedTurn;
  const latestText = deps.latestAssistantText ?? defaultLatestAssistantText;
  const pollMs = deps.pollMs ?? 200;
  const deadline = Date.now() + (deps.maxStreamMs ?? 30 * 60_000);
  const runIdAgui = meta.runId;
  const tail = createRunTail(request, deps, meta, emit);

  let output: (AgentTurnOutput & { runId: string }) | null = null;
  let failure: unknown = null;
  let settled = false;
  const turn = runTracked(
    {
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      userId: request.userId,
      role: request.role,
      threadId: request.threadId,
      userContent: request.userContent,
      attachmentIds: request.attachmentIds,
    },
    { onRunCreated: (id) => (tail.st.agentRunId = id) },
  ).then(
    (o) => {
      output = o;
      tail.st.agentRunId = o.runId;
    },
    (e: unknown) => {
      failure = e;
    },
  );
  void turn.finally(() => (settled = true));

  // While the request runs the turn: tail the run. (When the server drains,
  // an inline turn hands off to the worker at its next step boundary — see
  // lib/agents/loop.ts — so it settles as `queued` and we reconnect below.)
  while (!settled && Date.now() < deadline) {
    yield* tail.drain();
    await sleepOrSettle(pollMs, turn);
  }
  await turn;
  yield* tail.drain();

  if (failure) {
    yield* tail.closeMsg();
    yield* emit(
      stamp(
        {
          type: EventType.RUN_ERROR,
          threadId: request.threadId,
          runId: runIdAgui,
          message: failure instanceof Error ? failure.message : "Agent turn failed",
        },
        meta,
      ),
    );
    return;
  }

  let finalText = (output as (AgentTurnOutput & { runId: string }) | null)?.assistantText ?? "";
  if ((output as AgentTurnOutput | null)?.queued && tail.st.agentRunId) {
    // Handed to the worker: keep tailing until the run ends.
    yield* emit(stamp({ type: EventType.CUSTOM, name: MARKETR_CUSTOM_NAMES.queued, value: { runId: tail.st.agentRunId } }, meta));
    if ((yield* tail.tailUntilEnd(deadline)) === "stopped") {
      yield* tail.reconnect();
      return;
    }
    finalText = (await latestText(request.threadId).catch(() => null)) ?? "";
  }
  yield* tail.finish(finalText, request.threadId);
}

/** What a resumed chat stream needs (GET /api/agents/chat/stream). */
export interface AguiResumeRequest {
  workspaceId: string;
  threadId: string;
  /** The agent run behind the turn (the reconnect event's runId). */
  agentRunId: string;
  /** The original AG-UI run id, so message ids continue unchanged. */
  aguiRunId: string;
  /** Resume after this run-timeline seq (-1 = from the start). */
  afterSeq: number;
}

/**
 * Deploy PR: continue a chat turn's stream after a reconnect (this or
 * another replica): tail the run from `afterSeq` until it ends, then the
 * final text and RUN_FINISHED — the same tail as the live stream. Ends with
 * marketr.reconnect again if this server starts draining meanwhile.
 */
export async function* resumeChatTurnAgui(request: AguiResumeRequest, deps: AguiAdapterDeps = {}): AsyncGenerator<AguiEvent> {
  const meta: AguiRunMeta = { runId: request.aguiRunId, threadId: request.threadId, workspaceId: request.workspaceId };
  const log = createAguiLogger(meta, deps.logSink);
  const emit = function* (event: AguiEvent): Generator<AguiEvent> {
    log(event);
    yield event;
  };
  const latestText = deps.latestAssistantText ?? defaultLatestAssistantText;
  const tail = createRunTail(request, deps, meta, emit, request.afterSeq);
  tail.st.agentRunId = request.agentRunId;
  await tail.prime(request.afterSeq);
  const deadline = Date.now() + (deps.maxStreamMs ?? 30 * 60_000);
  if ((yield* tail.tailUntilEnd(deadline)) === "stopped") {
    yield* tail.reconnect();
    return;
  }
  const finalText = (await latestText(request.threadId).catch(() => null)) ?? "";
  yield* tail.finish(finalText, request.threadId);
}

/**
 * AguiEmitter — the sink future orchestrator/mission emitters build on.
 * Owns run context, sequence logging, and the free-floating event kinds
 * (STATE_SNAPSHOT/DELTA, STEP_STARTED/FINISHED, CUSTOM) that a chat turn
 * never produces. Not used by the chat adapter itself (which yields events
 * directly), but the orchestrator slice will drive missions through this.
 */
export class AguiEmitter {
  readonly meta: AguiRunMeta;
  private log: (event: AguiEvent) => void;
  readonly events: AguiEvent[] = [];

  constructor(meta: AguiRunMeta, logSink?: (line: string) => void) {
    this.meta = meta;
    this.log = createAguiLogger(meta, logSink);
  }

  emit(event: AguiEvent): AguiEvent {
    const stamped = withRunMeta({ ...event, timestamp: event.timestamp ?? Date.now() }, this.meta);
    this.events.push(stamped);
    this.log(stamped);
    return stamped;
  }

  /** Shared-state snapshot for CoAgents consumers (wired up in slice 4). */
  stateSnapshot(snapshot: Record<string, unknown>): AguiEvent {
    return this.emit({ type: EventType.STATE_SNAPSHOT, snapshot });
  }

  /** JSON-patch delta against the last snapshot. */
  stateDelta(delta: JsonPatch): AguiEvent {
    return this.emit({ type: EventType.STATE_DELTA, delta });
  }
}

/** Factory for a fresh run context (orchestrator/mission use). */
export function newAguiRunMeta(init: {
  threadId: string;
  workspaceId: string;
  runId?: string;
}): AguiRunMeta {
  return { runId: init.runId ?? randomUUID(), threadId: init.threadId, workspaceId: init.workspaceId };
}

/** Deploy PR: what the SSE layer hands the adapter (cursor + drain state). */
export interface AguiStreamHooks {
  onCursor: (agentRunId: string, seq: number) => void;
  shouldReconnect: () => boolean;
}

/**
 * Serialize an AG-UI event generator as a text/event-stream Response
 * (lib/http/sse.ts: heartbeats, ids, drain). One `data: <json>` frame per
 * event; the stream ends when the generator ends.
 *
 * Deploy PR: pass a factory to get the hooks — every frame then carries
 * `id: <agentRunId>:<seq>` (the run-timeline cursor), and when the server
 * drains the adapter stops at a clean boundary and the frame
 * `event: reconnect` + data { runId, after, aguiRunId } tells the client to
 * resume on GET /api/agents/chat/stream. The drain is cooperative: a turn
 * still running inline gets its hand-off window first, and the helper
 * forces the reconnect at its deadline.
 */
export function aguiStreamResponse(
  source: AsyncGenerator<AguiEvent> | ((hooks: AguiStreamHooks) => AsyncGenerator<AguiEvent>),
  opts: { lastEventId?: string | null; sse?: SseOptions } = {},
): Response {
  let cursor: { runId: string; seq: number } | null = null;
  let aguiRunId: string | null = null;
  const resumePoint = () => ({ runId: cursor?.runId ?? null, after: cursor?.seq ?? -1, aguiRunId });
  return sseResponse(
    async (ch) => {
      const hooks: AguiStreamHooks = {
        onCursor: (runId, seq) => (cursor = { runId, seq }),
        shouldReconnect: () => ch.draining,
      };
      const events = typeof source === "function" ? source(hooks) : source;
      // for-await's break hands the generator back (its finally blocks run).
      for await (const event of events) {
        if (ch.closed) break;
        const meta = (event.metadata as { marketr?: { runId?: unknown } } | undefined)?.marketr;
        if (!aguiRunId && typeof meta?.runId === "string") aguiRunId = meta.runId;
        if (event.type === EventType.CUSTOM && (event as { name?: unknown }).name === MARKETR_CUSTOM_NAMES.reconnect) {
          ch.reconnect((event as { value?: unknown }).value ?? resumePoint());
          break;
        }
        ch.send(null, event, { id: cursor ? `${cursor.runId}:${cursor.seq}` : null });
      }
    },
    { drain: "cooperative", lastEventId: opts.lastEventId ?? null, reconnectData: resumePoint, ...(opts.sse ?? {}) },
  );
}
