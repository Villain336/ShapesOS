// Marketr — Phase 16 slice 1: structured logging for AG-UI streaming events.
//
// Lightweight and deliberate: every emitted event gets one JSON log line so
// a run can be reconstructed from logs without replaying the SSE stream.
// No new DB tables in this slice — correlation keys (runId/threadId) are
// the join points for a later AgentRunEvent persistence slice.

import { EventType, type AguiEvent } from "./events";

export interface AguiLogLine {
  component: "agui";
  runId: string;
  threadId: string;
  workspaceId: string;
  seq: number;
  eventType: string;
  /** Short human summary of the payload (text prefix, tool name, outcome…). */
  detail: string;
  at: string;
}

function summarize(event: AguiEvent): string {
  switch (event.type) {
    case EventType.RUN_STARTED:
      return "run started";
    case EventType.TEXT_MESSAGE_START:
      return `message ${event.messageId} start`;
    case EventType.TEXT_MESSAGE_CONTENT:
      return `content +${event.delta.length} chars`;
    case EventType.TEXT_MESSAGE_END:
      return `message ${event.messageId} end`;
    case EventType.TOOL_CALL_START:
      return `tool ${event.toolCallName} (${event.toolCallId}) start`;
    case EventType.TOOL_CALL_ARGS:
      return `tool ${event.toolCallId} args`;
    case EventType.TOOL_CALL_END:
      return `tool ${event.toolCallId} end`;
    case EventType.TOOL_CALL_RESULT:
      return `tool ${event.toolCallId} result`;
    case EventType.CUSTOM:
      return `custom ${event.name}`;
    case EventType.RUN_FINISHED:
      return "run finished";
    case EventType.RUN_ERROR:
      return `run error: ${event.message}`;
    default:
      return event.type;
  }
}

/**
 * Create a sequential logger for one run. Emits one JSON line per event on
 * the supplied sink (defaults to console.info). Returns the emit function.
 */
export function createAguiLogger(
  meta: { runId: string; threadId: string; workspaceId: string },
  sink: (line: string) => void = (line) => console.info(line),
): (event: AguiEvent) => void {
  let seq = 0;
  return (event: AguiEvent) => {
    const line: AguiLogLine = {
      component: "agui",
      runId: meta.runId,
      threadId: meta.threadId,
      workspaceId: meta.workspaceId,
      seq: seq++,
      eventType: event.type,
      detail: summarize(event),
      at: new Date().toISOString(),
    };
    sink(JSON.stringify(line));
  };
}
