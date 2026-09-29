// Marketr — Phase 16 slice 1: AG-UI adapter for the chat agent.
//
// Wraps the existing chat agent (lib/chat/agent.ts) and replays each
// completed turn as an ordered AG-UI event sequence. The chat agent itself
// is non-token-streaming (one LLM call per loop iteration, tools executed
// between calls), so the adapter buffers the finished turn and emits the
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
}

export interface AguiAdapterDeps {
  /** Injectable turn executor — the default runs the real chat agent. */
  runTurn?: (input: AgentTurnInput) => Promise<AgentTurnOutput>;
  /** Injectable run-id factory (tests pin it). */
  newRunId?: () => string;
  /** Text chunker for TEXT_MESSAGE_CONTENT deltas. */
  chunkText?: (text: string) => string[];
  /** Log-line sink (defaults to structured console lines). */
  logSink?: (line: string) => void;
}

/** Default text chunker: fixed-width slices (no tokenization dependency). */
export const DEFAULT_CONTENT_CHUNK_SIZE = 400;

export function chunkTextFixed(text: string, size = DEFAULT_CONTENT_CHUNK_SIZE): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function defaultRunTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
  // Lazy import so loading the adapter never loads the agent (and its
  // prisma/LLM graph) — keeps the contract tests fast and side-effect free.
  return import("@/lib/chat/agent").then((m) => m.runAgentTurnWithCapture(input));
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

  let output: AgentTurnOutput;
  try {
    const runTurn = deps.runTurn ?? defaultRunTurn;
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
