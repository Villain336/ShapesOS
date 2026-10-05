// Marketr — Phase 14: the agent tool-call surface (slice 4).
//
// agentInvokeAction() is the ONLY path an agent (Chief Strategy Agent,
// missions, playbooks) may use to call a Composio tool. It enforces the
// conservative gating by construction:
//
//   low (reads) + draft-creators  -> execute directly, ALWAYS logged.
//   medium, under an auto rule    -> Phase 14 (owner decision 2026-10-05):
//                                    a rule keyed "composio:<toolkit>" set to
//                                    Auto-run executes a classified medium
//                                    (non-destructive) write directly, ALWAYS
//                                    logged with the rule — unless its name is
//                                    money / irreversible (DoA Tier 3).
//   everything else               -> proposeApproval, NEVER executed here.
//                                    High (destructive) always asks. The human
//                                    approves in /dashboard/actions;
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
import { resolveToolkitForTool, TOOLKIT_CATEGORY } from "@/lib/integrations/actions/toolkits";
import {
  logAction,
  proposeAction,
} from "@/lib/integrations/actions/gate";
import { containsRedactedPlaceholder, REDACTED_PLACEHOLDER } from "@/lib/integrations/actions/redact";
import { getComposioBudgetWarning } from "@/lib/integrations/actions/budget";
import { COMPOSIO_MONEY_TOOLKIT_RE, EXTERNAL_TOOL_MONEY_RE, autoApprovalFor, type AutoApprovalInput } from "@/lib/automation/policy";

/** Phase 14: the automation action a Composio toolkit's rule is keyed on. */
export function composioAction(toolkitSlug: string): string {
  return `composio:${toolkitSlug}`;
}

/**
 * Phase 14: Composio toolkits that move money (payments, accounting,
 * payroll, banking, commerce checkout) — no rule ever covers their writes —
 * and money words in a tool name beyond the DoA Tier-3 verbs (a Stripe
 * "create charge" or a "send invoice" carries no purchase/refund/transfer
 * verb). Fail closed: matching either means "always asks".
 */
export { COMPOSIO_MONEY_TOOLKIT_RE };
export const COMPOSIO_MONEY_TOOL_RE = EXTERNAL_TOOL_MONEY_RE;

/**
 * Phase 14 — PURE. The auto-approve question for a Composio call, or null
 * when no rule may ever cover it: only a confidently classified MEDIUM
 * write of a known, non-money toolkit qualifies (high = destructive, always
 * asks; low / draft-creators already run; a payments / accounting toolkit
 * or a money word in the tool name always asks). The tool name is also the
 * description the DoA evaluator scans, so a refund / purchase / delete tool
 * is Tier 3 and can never auto-run, whatever the rule says.
 */
export function composioAutoInput(
  classified: Pick<ClassifiedAction, "tier" | "classified" | "autoExecutable">,
  toolkitSlug: string | null | undefined,
  toolName: string,
  agentKey: string = "*",
): AutoApprovalInput | null {
  if (classified.autoExecutable || classified.tier !== "medium" || !classified.classified || !toolkitSlug) return null;
  if (TOOLKIT_CATEGORY[toolkitSlug] === "payments" || COMPOSIO_MONEY_TOOLKIT_RE.test(toolkitSlug)) return null;
  if (COMPOSIO_MONEY_TOOL_RE.test(toolName.toLowerCase().replace(/_/g, " "))) return null;
  return {
    agentKey,
    action: composioAction(toolkitSlug),
    description: toolName.toLowerCase().replace(/_/g, " "),
  };
}

export interface AgentInvokeInput {
  workspaceId: string;
  appKey: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Who invoked (agent id / mission id / user id) — lands in the audit log. */
  invokedBy: string;
  /** Phase 14: the agent asking (its own rule wins over the every-agent rule). */
  agentKey?: string;
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
  // Phase 15 slice 6 — resolve the toolkit so the auto-read accuracy gate
  // inside classifyAction can escalate a derived low tier to medium when
  // the toolkit hasn't passed the sampled tier-accuracy eval (fail-closed:
  // reads stay usable via approval, never silent).
  const toolkitSlug = await resolveToolkitForTool(input.workspaceId, input.toolName);
  const classified = classifyAction(input.toolName, overrides, { appKey: input.appKey, toolkitSlug });
  // Fail-closed: no connection row -> no execution, no proposal.
  const connectedAccountId = await requireConnectedEntity(input.workspaceId, input.appKey);

  // Phase 14: a "composio:<toolkit>" rule may let a medium write run.
  const autoInput = composioAutoInput(classified, toolkitSlug, input.toolName, input.agentKey);
  const autoDecision = autoInput ? await autoApprovalFor(input.workspaceId, autoInput).catch(() => null) : null;
  const autoReason = autoDecision?.auto ? autoDecision.reason : null;

  if (!classified.autoExecutable && !autoReason) {
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
  // Phase 14 slice 10: same advisory budget warning as the gated path.
  const budgetWarning = await getComposioBudgetWarning({
    workspaceId: input.workspaceId,
    toolName: input.toolName,
  });
  try {
    // Fail closed (Tico, 2026-09-28): redaction is for storage/logs, never
    // for the live call — and a "[redacted]" placeholder value must never
    // reach a tool. The call carries the FULL args; logAction redacts the
    // stored summary (summarizeArgs).
    if (containsRedactedPlaceholder(input.args)) {
      throw new Error(
        `Cannot execute: arguments contain the ${REDACTED_PLACEHOLDER} placeholder — ` +
          "redaction is for storage/logs only and will not be sent to a tool. " +
          "Re-propose the action with real argument values.",
      );
    }
    const res = await executeComposioTool(
      {
        slug: input.toolName,
        connectedAccountId,
        args: input.args,
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
    resultSummary: {
      ...resultSummary,
      ...(budgetWarning ? { budgetWarning } : {}),
      // Phase 14: the audit names the rule that let a medium write run.
      ...(autoReason ? { autoApproved: autoReason } : {}),
    },
    latencyMs: Date.now() - started,
    status,
    executedBy: input.invokedBy,
  });
  if (status === "failed") {
    throw new Error(`Action failed: ${JSON.stringify(resultSummary).slice(0, 200)}`);
  }
  return {
    outcome: "executed",
    classified,
    resultSummary: budgetWarning ? { ...resultSummary, budgetWarning } : resultSummary,
    latencyMs: Date.now() - started,
  };
}
