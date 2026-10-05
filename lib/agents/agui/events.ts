// Marketr — Phase 16 slice 1: AG-UI protocol event surface.
//
// Typed AG-UI event definitions for the agent backend. Types come from the
// official protocol package `@ag-ui/core` (pinned to 1.0.0 — exact pin in
// package.json, MIT license, https://github.com/ag-ui-protocol/ag-ui) and
// mirror AG-UI protocol version 1.0. Runtime validation uses the package's
// zod schemas (`@ag-ui/core/schemas`).
//
// This module is intentionally protocol-only: it knows nothing about
// Marketr's chat agent or orchestrator. The chat adapter (adapter.ts) and
// future orchestrator/mission emitters build on these types.

import {
  PROTOCOL_VERSION,
  EventType,
  type Event as AguiEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type JsonPatch,
  type StateSnapshotEvent,
  type StateDeltaEvent,
  type CustomEvent,
} from "@ag-ui/core";
import { EventSchema } from "@ag-ui/core/schemas";

export { PROTOCOL_VERSION, EventType };

export type {
  AguiEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  JsonPatch,
  StateSnapshotEvent,
  StateDeltaEvent,
  CustomEvent,
};

/** AG-UI protocol version this module mirrors (from @ag-ui/core@1.0.0). */
export const AGUI_PROTOCOL_VERSION = PROTOCOL_VERSION; // "1.0"

/**
 * Marketr-side run context every emitted event is attributed to.
 * threadId/runId ride on the AG-UI events that carry them (RUN_*); the rest
 * travel in metadata.marketr so consumers can always correlate.
 */
export interface AguiRunMeta {
  runId: string;
  threadId: string;
  workspaceId: string;
}

/** Attach run correlation to any event's metadata (non-destructive). */
export function withRunMeta<E extends AguiEvent>(event: E, meta: AguiRunMeta): E {
  return {
    ...event,
    metadata: { ...(event.metadata ?? {}), marketr: { runId: meta.runId, threadId: meta.threadId, workspaceId: meta.workspaceId } },
  } as E;
}

/** Validate one event against the official AG-UI protocol schema. */
export function isValidAguiEvent(event: unknown): boolean {
  return EventSchema.safeParse(event).success;
}

/**
 * Ordering invariants for a chat-turn event sequence (protocol §6):
 * - RUN_STARTED first, RUN_FINISHED or RUN_ERROR last (exactly once each).
 * - Each TEXT_MESSAGE_START is followed by ≥0 CONTENT then exactly one END
 *   before the next START; START before CONTENT before END.
 * - Each TOOL_CALL_START is followed by ARGS/END for the same toolCallId;
 *   START before ARGS before END.
 * Throws on the first violation — used by the adapter contract tests.
 */
export function assertAguiSequence(events: readonly AguiEvent[]): void {
  if (events.length === 0) throw new Error("agui: empty event sequence");
  if (events[0].type !== EventType.RUN_STARTED) throw new Error("agui: sequence must start with RUN_STARTED");
  const last = events[events.length - 1];
  if (last.type !== EventType.RUN_FINISHED && last.type !== EventType.RUN_ERROR) {
    throw new Error("agui: sequence must end with RUN_FINISHED or RUN_ERROR");
  }

  let openMessage: string | null = null;
  const openTools = new Set<string>();
  let runClosed = false;

  for (const [i, e] of events.entries()) {
    const at = `event ${i} (${e.type})`;
    if (runClosed) throw new Error(`agui: ${at} — event after run closed`);

    switch (e.type) {
      case EventType.RUN_STARTED:
        if (i !== 0) throw new Error(`agui: ${at} — duplicate RUN_STARTED`);
        break;
      case EventType.TEXT_MESSAGE_START: {
        if (openMessage) throw new Error(`agui: ${at} — message ${openMessage} still open`);
        const id = (e as TextMessageStartEvent).messageId;
        if (!id) throw new Error(`agui: ${at} — TEXT_MESSAGE_START requires messageId`);
        openMessage = id;
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT:
        if (!openMessage) throw new Error(`agui: ${at} — CONTENT without an open message`);
        if ((e as TextMessageContentEvent).messageId !== openMessage) {
          throw new Error(`agui: ${at} — CONTENT messageId mismatch`);
        }
        break;
      case EventType.TEXT_MESSAGE_END:
        if (!openMessage) throw new Error(`agui: ${at} — END without an open message`);
        if ((e as TextMessageEndEvent).messageId !== openMessage) {
          throw new Error(`agui: ${at} — END messageId mismatch`);
        }
        openMessage = null;
        break;
      case EventType.TOOL_CALL_START: {
        const id = (e as ToolCallStartEvent).toolCallId;
        if (!id) throw new Error(`agui: ${at} — TOOL_CALL_START requires toolCallId`);
        if (openTools.has(id)) throw new Error(`agui: ${at} — toolCallId ${id} already open`);
        openTools.add(id);
        break;
      }
      case EventType.TOOL_CALL_ARGS:
      case EventType.TOOL_CALL_END: {
        const id = (e as ToolCallArgsEvent | ToolCallEndEvent).toolCallId;
        if (!openTools.has(id)) throw new Error(`agui: ${at} — ${e.type} for unopened toolCallId ${id}`);
        if (e.type === EventType.TOOL_CALL_END) openTools.delete(id);
        break;
      }
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
        if (openMessage) throw new Error(`agui: ${at} — run closed with message ${openMessage} open`);
        if (openTools.size > 0) throw new Error(`agui: ${at} — run closed with ${openTools.size} tool call(s) open`);
        runClosed = true;
        break;
      default:
        // STATE_*, CUSTOM, RAW, STEP_*, SUBAGENT_*, REASONING_* are free-floating
        // in the sequence (they plug in for orchestrator runs later).
        break;
    }
  }
}

/**
 * The protocol event kinds the Marketr adapter emits today, and the kinds
 * reserved for later slices (orchestrator STATE_*, HITL CUSTOM names).
 */
export const MARKETR_EMITTED_KINDS = [
  EventType.RUN_STARTED,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_RESULT,
  EventType.CUSTOM,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
] as const;

/** CUSTOM event names reserved for Marketr-native payloads. */
export const MARKETR_CUSTOM_NAMES = {
  /** A tool call held behind the confirmation gate (pending_confirmation). */
  toolProposal: "marketr.toolProposal",
  /** Phase 8: the turn was handed to the agent worker; the stream keeps tailing it. */
  queued: "marketr.queued",
  /**
   * Deploy PR: this server is shutting down; resume the turn on another
   * replica (GET /api/agents/chat/stream) from { runId, after, aguiRunId }.
   */
  reconnect: "marketr.reconnect",
} as const;
