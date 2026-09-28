// Marketr — Phase 14: Actor executor (Chief Strategy Agent).
//
// The orchestrator's hands. runActor() routes a tool call through
// agentInvokeAction() — the Phase 14 action surface — so reads and
// draft-creators execute (logged) and everything else lands in the
// approve/deny queue. The executor can never bypass the gate: it has no
// Composio access of its own.
//
// Follows the executor dep pattern: kill switches checked first, the
// invoke function is injectable for tests (default: real agentInvokeAction).

import { agentInvokeAction, type AgentInvokeOutcome } from "@/lib/integrations/actions/agent";
import type { ComposioHttp } from "@/lib/integrations/composio";
import {
  assertToolAllowed,
  checkKillSwitchesFirst,
  ExecutorError,
  type GuardDeps,
} from "./_guard";

/** The only tool this executor may touch — everything else throws. */
export const ACTOR_TOOLS = Object.freeze(["actions.invoke"]) as readonly string[];

export interface ActorInput {
  workspaceId: string;
  missionId?: string | null;
  /** v1 app key (gmail, google-sheets, slack, hubspot, notion). */
  appKey: string;
  /** Composio tool slug, e.g. GMAIL_LIST_MESSAGES. */
  toolName: string;
  args?: Record<string, unknown>;
  /** Who is invoking (agent label) — lands in the audit log. */
  invokedBy?: string;
}

export interface ActorDeps extends GuardDeps {
  /** Override the action surface (tests). Default: agentInvokeAction. */
  invoke?: (input: Parameters<typeof agentInvokeAction>[0]) => Promise<AgentInvokeOutcome>;
  http?: ComposioHttp;
}

export interface ActorResult {
  summary: string;
  costCents: number;
  outcome: AgentInvokeOutcome["outcome"];
  approvalId?: string;
}

function preValidate(input: ActorInput): void {
  if (!input.appKey?.trim()) throw new ExecutorError("actor: appKey is required");
  if (!input.toolName?.trim()) throw new ExecutorError("actor: toolName is required");
}

/**
 * runActor — execute a single connected-app tool call through the Phase 14
 * gate. Reads/draft-creators run and are logged; writes/destructive
 * actions return pending-approval for the human queue.
 */
export async function runActor(input: ActorInput, deps: ActorDeps = {}): Promise<ActorResult> {
  await checkKillSwitchesFirst(input, deps);
  assertToolAllowed("actor", ACTOR_TOOLS, "actions.invoke");
  preValidate(input);
  const invoke = deps.invoke ?? agentInvokeAction;
  const res = await invoke({
    workspaceId: input.workspaceId,
    appKey: input.appKey,
    toolName: input.toolName,
    args: input.args ?? {},
    invokedBy: input.invokedBy ?? `actor${input.missionId ? `:${input.missionId}` : ""}`,
    http: deps.http,
  });
  if (res.outcome === "executed") {
    return {
      summary: `Executed ${input.appKey}.${input.toolName} (${res.classified.tier}, ${res.latencyMs}ms) — logged.`,
      costCents: 0,
      outcome: "executed",
    };
  }
  return {
    summary: `Action ${input.appKey}.${input.toolName} needs human approval: ${res.plainSummary} (approval ${res.approvalId}).`,
    costCents: 0,
    outcome: "pending-approval",
    approvalId: res.approvalId,
  };
}
