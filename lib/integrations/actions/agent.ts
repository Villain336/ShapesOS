// Marketr — Phase 14: the agent tool-call surface (slice 4).
//
// agentInvokeAction() is the ONLY path an agent (Chief Strategy Agent,
// missions, playbooks) may use to call a Composio tool. It enforces the
// conservative gating by construction:
//
//   low (reads) + draft-creators  -> execute directly, ALWAYS logged.
//   everything else               -> proposeApproval, NEVER executed here.
//                                    The human approves in /dashboard/actions;
//                                    executeApproved() (gate.ts) is the only
//                                    execution path for gated tiers.
//
// Fail-closed: unconnected app -> throws before any HTTP. No Composio key
// -> the HTTP boundary throws ComposioConfigError (composio.ts).

import {
  executeComposioTool,
  type ComposioHttp,
} from "@/lib/integrations/composio";
import {
  classifyAction,
  type ClassifiedAction,
} from "@/lib/integrations/actions/risk";
import {
  getToolTierOverrides,
  requireConnectedEntity,
} from "@/lib/integrations/actions/connections";
import {
  logAction,
  proposeAction,
} from "@/lib/integrations/actions/gate";
import { redactArgs } from "@/lib/integrations/actions/redact";

export interface AgentInvokeInput {
  workspaceId: string;
  appKey: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Who invoked (agent id / mission id / user id) — lands in the audit log. */
  invokedBy: string;
  http?: ComposioHttp;
}

export type AgentInvokeOutcome =
  | {
      outcome: "executed";
      classified: ClassifiedAction;
      resultSummary: Record<string, unknown>;
      latencyMs: number;
    }
  | {
      outcome: "pending-approval";
      classified: ClassifiedAction;
      approvalId: string;
      plainSummary: string;
    };

/**
 * Agent tool call. Auto-executes ONLY autoExecutable tiers (low reads,
 * draft-creators); everything else becomes a pending approval. Every
 * path writes a log entry (execute) or an approval row (gated).
 */
export async function agentInvokeAction(input: AgentInvokeInput): Promise<AgentInvokeOutcome> {
  const overrides = await getToolTierOverrides(input.workspaceId);
  const classified = classifyAction(input.toolName, overrides);
  // Fail-closed: no connection row -> no execution, no proposal.
  const connectedAccountId = await requireConnectedEntity(input.workspaceId, input.appKey);

  if (!classified.autoExecutable) {
    const { approval } = await proposeAction({
      workspaceId: input.workspaceId,
      appKey: input.appKey,
      toolName: input.toolName,
      args: input.args,
      proposedBy: input.invokedBy,
    });
    return {
      outcome: "pending-approval",
      classified,
      approvalId: approval.id,
      plainSummary: approval.plainSummary,
    };
  }

  const started = Date.now();
  let status: "success" | "failed" = "success";
  let resultSummary: Record<string, unknown> = {};
  try {
    const res = await executeComposioTool(
      {
        slug: input.toolName,
        connectedAccountId,
        args: redactArgs(input.args),
      },
      input.http,
    );
    if (!res.successful) {
      status = "failed";
      resultSummary = { error: String(res.error ?? "unknown").slice(0, 500) };
    } else {
      resultSummary = { ok: true };
    }
  } catch (e) {
    status = "failed";
    resultSummary = { error: (e as Error).message.slice(0, 500) };
  }
  await logAction({
    workspaceId: input.workspaceId,
    appKey: input.appKey,
    toolName: input.toolName,
    riskTier: classified.tier,
    argsSummary: input.args,
    resultSummary,
    latencyMs: Date.now() - started,
    status,
    executedBy: input.invokedBy,
  });
  if (status === "failed") {
    throw new Error(`Action failed: ${JSON.stringify(resultSummary).slice(0, 200)}`);
  }
  return { outcome: "executed", classified, resultSummary, latencyMs: Date.now() - started };
}
