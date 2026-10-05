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
  const listEvents = deps.listRunEvents ?? defaultListRunEvents;
  const getStatus = deps.getRunStatus ?? defaultGetRunStatus;
  const latestText = deps.latestAssistantText ?? defaultLatestAssistantText;
  const pollMs = deps.pollMs ?? 200;
  const deadline = Date.now() + (deps.maxStreamMs ?? 30 * 60_000);
  const runIdAgui = meta.runId;

  let agentRunId: string | null = null;
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
    { onRunCreated: (id) => (agentRunId = id) },
  ).then(
    (o) => {
      output = o;
      agentRunId = o.runId;
    },
    (e: unknown) => {
      failure = e;
    },
  );
  void turn.finally(() => (settled = true));

  let lastSeq = -1;
  let openMsg: string | null = null;
  let openText = "";
  const openTools = new Set<string>();
  const seenTools = new Set<string>();

  const closeMsg = function* (): Generator<AguiEvent> {
    if (!openMsg) return;
    yield* emit(stamp({ type: EventType.TEXT_MESSAGE_END, messageId: openMsg }, meta));
    openMsg = null;
  };
  const mapEvent = function* (ev: TailedRunEvent): Generator<AguiEvent> {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.type === "text" && p.kind === "text_delta" && typeof p.text === "string") {
      const id = `${runIdAgui}:msg:${agentRunId}:${String(p.step ?? 0)}`;
      if (openMsg !== id) {
        yield* closeMsg();
        openMsg = id;
        openText = "";
        yield* emit(stamp({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" }, meta));
      }
      openText += p.text;
      yield* emit(stamp({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: p.text } as TextMessageContentEvent, meta));
      return;
    }
    const toolUseId = typeof p.toolUseId === "string" ? p.toolUseId : null;
    const tool = typeof p.tool === "string" ? p.tool : null;
    if (!toolUseId || !tool) return;
    const toolCallId = `${runIdAgui}:tool:${toolUseId}`;
    const start = function* (args: unknown): Generator<AguiEvent> {
      if (seenTools.has(toolCallId)) return;
      seenTools.add(toolCallId);
      yield* closeMsg();
      openTools.add(toolCallId);
      yield* emit(stamp({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: tool, parentMessageId: `${runIdAgui}:msg:assistant` }, meta));
      yield* emit(stamp({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args ?? {}) } as ToolCallArgsEvent, meta));
      yield* emit(stamp({ type: EventType.TOOL_CALL_END, toolCallId }, meta));
      openTools.delete(toolCallId);
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
    if (!agentRunId) return;
    for (;;) {
      const batch = await listEvents(request.workspaceId, agentRunId, lastSeq).catch(() => [] as TailedRunEvent[]);
      for (const ev of batch) {
        lastSeq = Math.max(lastSeq, ev.seq);
        yield* mapEvent(ev);
      }
      if (batch.length < 500) return;
    }
  };

  // While the request runs the turn: tail the run.
  while (!settled && Date.now() < deadline) {
    yield* drain();
    await sleepOrSettle(pollMs, turn);
  }
  await turn;
  yield* drain();

  if (failure) {
    yield* closeMsg();
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
  if ((output as AgentTurnOutput | null)?.queued && agentRunId) {
    // Handed to the worker: keep tailing until the run ends.
    yield* emit(stamp({ type: EventType.CUSTOM, name: MARKETR_CUSTOM_NAMES.queued, value: { runId: agentRunId } }, meta));
    for (;;) {
      yield* drain();
      const status = await getStatus(request.workspaceId, agentRunId).catch(() => null);
      if (!status || TAIL_ENDS.has(status) || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.max(pollMs, 500)));
    }
    yield* drain();
    finalText = (await latestText(request.threadId).catch(() => null)) ?? "";
  }

  // Reconcile the final (delivered) text with what streamed.
  const final = finalText.trim();
  if (final) {
    if (openMsg && final.startsWith(openText.trim()) && openText.trim()) {
      const rest = finalText.slice(finalText.indexOf(openText.trim()) + openText.trim().length);
      if (rest) yield* emit(stamp({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: openMsg, delta: rest } as TextMessageContentEvent, meta));
      yield* closeMsg();
    } else if (!openMsg || final !== openText.trim()) {
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
  yield* emit(stamp({ type: EventType.RUN_FINISHED, threadId: request.threadId, runId: runIdAgui, outcome: { type: "success" } }, meta));
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

/**
 * Serialize an AG-UI event generator as a text/event-stream Response.
 * One `data: <json>` frame per event; stream ends when the generator ends.
 */
export function aguiStreamResponse(events: AsyncGenerator<AguiEvent>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
