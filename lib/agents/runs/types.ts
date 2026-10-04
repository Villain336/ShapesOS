// Marketr — Phase 16 slice 5: viewable agent runs (Playwright recorder).
//
// Shared domain types for persisted agent runs. Pure — no prisma, no DOM,
// no network. The DB layer is service.ts; the browser layer is recorder.ts.

/** Agent run kinds (spec §4). "follow_up" = follow-up run linked to a thread;
 *  "chat" (Phase 5) = one assistant / task turn by the lead or a sub-agent. */
export type AgentRunKind = "mission" | "playbook" | "browser" | "follow_up" | "chat";

/** Run lifecycle status. Terminal: succeeded | failed | cancelled. */
export type AgentRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Timeline event types (spec §4) — agui = protocol events, gate = Phase 14
 *  gate decisions, browser = Playwright actions, note = freeform. */
export type AgentRunEventType = "agui" | "gate" | "browser" | "note";

export const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/** Structured run event before persistence (seq assigned by the service). */
export interface AgentRunEventInput {
  type: AgentRunEventType;
  /** Short human-readable timeline summary (one line). */
  summary: string;
  /** Full structured detail for the viewer (slice 6). */
  payload?: Record<string, unknown>;
}

/** Linkage for a run back to the requesting surface. */
export interface AgentRunLinkage {
  threadId?: string;
  missionId?: string;
  /** Phase 5: the agent that runs it ("lead" or a sub-agent key). */
  agentKey?: string;
  /** Phase 5: the run that handed this work off (sub-agent tree). */
  parentRunId?: string;
  /** Phase 5: the server-computed tool grant (lib/agents/grants.ts). */
  allowedTools?: readonly string[];
}

/** Result handed to the recorder's browser callback. */
export interface BrowserRunOutcome {
  /** Structured result the agent's browser tool returns (kept small). */
  result: Record<string, unknown>;
}
