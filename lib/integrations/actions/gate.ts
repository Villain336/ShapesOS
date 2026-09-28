// Marketr — Phase 14: the approval gate (spec §3). THE choke point.
//
// Conservative gating (locked): low-tier reads + draft-creators execute
// automatically (always logged); every external write and all destructive
// actions land in the approve/deny queue. NOTHING gated executes without
// an approved, unexpired ComposioActionApproval — executeApproved() is the
// only path that calls Composio for a gated tier, and attempted bypass
// fails closed (proven by negative tests).
//
// Designed to migrate onto Latchkey's approve/deny workflow (M2): the
// interface stays narrow — propose → approve/deny/edit → execute → audit.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  executeComposioTool,
  type ComposioHttp,
} from "@/lib/integrations/composio";
import {
  classifyAction,
  type RiskTier,
} from "@/lib/integrations/actions/risk";
import { getToolTierOverrides, requireConnectedEntity } from "@/lib/integrations/actions/connections";
import { redactArgs, summarizeArgs } from "@/lib/integrations/actions/redact";
import { summarizeAction } from "@/lib/integrations/actions/summarize";

export const APPROVAL_TTL_MS = Number(process.env.ACTION_APPROVAL_TTL_MS ?? 24 * 3600_000);

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

interface AuditEvent {
  at: string;
  actor: string;
  event: string;
  detail?: string;
}

function trail(existing: unknown, event: AuditEvent): AuditEvent[] {
  const arr = Array.isArray(existing) ? (existing as AuditEvent[]) : [];
  return [...arr, event];
}

function nowIso() {
  return new Date().toISOString();
}

/** Prisma Json fields need InputJsonValue; redacted args are JSON-safe. */
function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

export interface ProposeInput {
  workspaceId: string;
  appKey: string;
  toolName: string;
  args: Record<string, unknown>;
  proposedBy: string;
  plainSummary?: string;
  ttlMs?: number;
}

/**
 * Propose an action for human review. Classifies the tier (manual
 * overrides win), redacts sensitive args, and creates a pending approval.
 * Returns the approval id + classification so the caller can route.
 */
export async function proposeAction(input: ProposeInput) {
  const overrides = await getToolTierOverrides(input.workspaceId);
  const classified = classifyAction(input.toolName, overrides);
  const redacted = redactArgs(input.args);
  const summary = input.plainSummary ?? summarizeAction(input.appKey, input.toolName, redacted);
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? APPROVAL_TTL_MS));
  const approval = await withWorkspaceScope(input.workspaceId, (tx) =>
    tx.composioActionApproval.create({
      data: {
        workspaceId: input.workspaceId,
        appKey: input.appKey,
        toolName: input.toolName.toUpperCase(),
        riskTier: classified.tier,
        proposedArgs: toJson(redacted),
        plainSummary: summary,
        status: "pending",
        expiresAt,
        auditTrail: toJson(trail([], {
          at: nowIso(),
          actor: input.proposedBy,
          event: "proposed",
          detail: `tier=${classified.tier}${classified.overridden ? " (override)" : ""}${classified.clamped ? " — override clamped at conservative floor" : ""}${classified.draftCreator ? " draft-creator" : ""}`,
        })),
      },
      select: { id: true, status: true, riskTier: true, plainSummary: true, expiresAt: true },
    }),
  );
  return { approval, classified };
}

export interface DecideInput {
  workspaceId: string;
  approvalId: string;
  decision: "approved" | "denied";
  decidedBy: string;
  reason?: string;
  /** Edit-before-approve: replaces the proposed args (re-redacted). */
  editedArgs?: Record<string, unknown>;
}

/** Approve or deny a pending approval. Denial kills the action with a
 *  reason; approval arms it for executeApproved(). */
export async function decideApproval(input: DecideInput) {
  return withWorkspaceScope(input.workspaceId, async (tx) => {
    const approval = await tx.composioActionApproval.findFirst({
      where: { id: input.approvalId, workspaceId: input.workspaceId },
    });
    if (!approval) throw new Error("Approval not found");
    if (approval.status !== "pending") {
      throw new Error(`Approval is ${approval.status}, not pending`);
    }
    if (approval.expiresAt.getTime() < Date.now()) {
      const expired = await tx.composioActionApproval.update({
        where: { id: approval.id },
        data: {
          status: "expired",
          auditTrail: toJson(trail(approval.auditTrail, { at: nowIso(), actor: "system", event: "expired" })),
        },
        select: { id: true, status: true },
      });
      throw new Error("Approval expired before decision");
    }
    const redacted = input.editedArgs ? redactArgs(input.editedArgs) : undefined;
    const updated = await tx.composioActionApproval.update({
      where: { id: approval.id },
      data: {
        status: input.decision === "approved" ? "approved" : "denied",
        decidedBy: input.decidedBy,
        decidedAt: new Date(),
        decisionReason: input.reason?.trim() || null,
        ...(redacted
          ? {
              proposedArgs: toJson(redacted),
              plainSummary: summarizeAction(approval.appKey, approval.toolName, redacted),
            }
          : {}),
        auditTrail: toJson(trail(approval.auditTrail, {
          at: nowIso(),
          actor: input.decidedBy,
          event: input.decision,
          detail: input.reason?.trim() || (redacted ? "args edited before approve" : undefined),
        })),
      },
      select: { id: true, status: true, riskTier: true, plainSummary: true },
    });
    return updated;
  });
}

export async function listApprovals(
  workspaceId: string,
  opts?: { status?: ApprovalStatus | "all"; limit?: number },
) {
  await expireStaleApprovals(workspaceId);
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.composioActionApproval.findMany({
      where: {
        workspaceId,
        ...(opts?.status && opts.status !== "all" ? { status: opts.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: opts?.limit ?? 50,
      select: {
        id: true,
        appKey: true,
        toolName: true,
        riskTier: true,
        plainSummary: true,
        status: true,
        decidedBy: true,
        decidedAt: true,
        decisionReason: true,
        expiresAt: true,
        createdAt: true,
      },
    }),
  );
}

export async function getApproval(workspaceId: string, id: string) {
  await expireStaleApprovals(workspaceId);
  const approval = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioActionApproval.findFirst({
      where: { id, workspaceId },
    }),
  );
  if (!approval) throw new Error("Approval not found");
  return approval;
}

/** Sweep pending approvals past their expiry. Returns the count expired. */
export async function expireStaleApprovals(workspaceId?: string) {
  const sweep = async (wsId: string) =>
    withWorkspaceScope(wsId, async (tx) => {
      const stale = await tx.composioActionApproval.findMany({
        where: { workspaceId: wsId, status: "pending", expiresAt: { lt: new Date() } },
        select: { id: true, auditTrail: true },
      });
      for (const row of stale) {
        await tx.composioActionApproval.update({
          where: { id: row.id },
          data: {
            status: "expired",
            auditTrail: toJson(trail(row.auditTrail, { at: nowIso(), actor: "system", event: "expired" })),
          },
        });
      }
      return stale.length;
    });
  if (workspaceId) return sweep(workspaceId);
  // Cross-workspace sweep: iterate workspace ids that have pending approvals.
  // RLS hides rows without the GUC, so collect ids via a scoped raw query
  // per candidate... instead: raw query bypasses RLS only for the id list
  // (ids are not sensitive; rows stay protected).
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT DISTINCT workspace_id FROM composio_action_approvals WHERE status = 'pending' AND expires_at < now()`,
  )) as Array<{ workspace_id: string }>;
  let total = 0;
  for (const r of rows) total += await sweep(r.workspace_id);
  return total;
}

export interface ExecuteApprovedInput {
  workspaceId: string;
  approvalId: string;
  executedBy: string;
  http?: ComposioHttp;
}

/**
 * THE choke point for gated actions. Loads the approval, requires
 * approved + unexpired, executes via Composio, and ALWAYS writes a
 * ComposioActionLog — nothing executes without a log entry.
 */
export async function executeApproved(input: ExecuteApprovedInput) {
  const approval = await withWorkspaceScope(input.workspaceId, (tx) =>
    tx.composioActionApproval.findFirst({
      where: { id: input.approvalId, workspaceId: input.workspaceId },
    }),
  );
  if (!approval) throw new Error("Approval not found");
  if (approval.status !== "approved") {
    throw new Error(`Cannot execute: approval is ${approval.status} (must be approved)`);
  }
  if (approval.expiresAt.getTime() < Date.now()) {
    await expireStaleApprovals(input.workspaceId);
    throw new Error("Cannot execute: approval expired");
  }
  const connectedAccountId = await requireConnectedEntity(input.workspaceId, approval.appKey);
  const started = Date.now();
  let status: "success" | "failed" = "success";
  let resultSummary: Record<string, unknown> = {};
  try {
    const res = await executeComposioTool(
      {
        slug: approval.toolName,
        connectedAccountId,
        args: (approval.proposedArgs as Record<string, unknown>) ?? {},
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
    approvalId: approval.id,
    appKey: approval.appKey,
    toolName: approval.toolName,
    riskTier: approval.riskTier as RiskTier,
    argsSummary: (approval.proposedArgs as Record<string, unknown>) ?? {},
    resultSummary,
    latencyMs: Date.now() - started,
    status,
    executedBy: input.executedBy,
  });
  if (status === "failed") {
    throw new Error(`Action failed: ${JSON.stringify(resultSummary).slice(0, 200)}`);
  }
  return { ok: true, latencyMs: Date.now() - started };
}

export interface LogActionInput {
  workspaceId: string;
  approvalId?: string;
  appKey: string;
  toolName: string;
  riskTier: RiskTier;
  argsSummary?: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
  latencyMs?: number;
  status: "success" | "failed" | "denied" | "expired";
  executedBy: string;
}

/** Write the audit/metering record. Every execution path calls this. */
export async function logAction(input: LogActionInput) {
  return withWorkspaceScope(input.workspaceId, (tx) =>
    tx.composioActionLog.create({
      data: {
        workspaceId: input.workspaceId,
        approvalId: input.approvalId,
        appKey: input.appKey,
        toolName: input.toolName.toUpperCase(),
        riskTier: input.riskTier,
        argsSummary: toJson(summarizeArgs(input.argsSummary ?? {})),
        resultSummary: toJson(input.resultSummary ?? {}),
        latencyMs: input.latencyMs,
        status: input.status,
        executedBy: input.executedBy,
      },
      select: { id: true },
    }),
  );
}

/** Recent action log entries (audit view), newest first. */
export async function listActionLogs(workspaceId: string, limit = 50) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.composioActionLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        appKey: true,
        toolName: true,
        riskTier: true,
        status: true,
        executedBy: true,
        latencyMs: true,
        createdAt: true,
      },
    }),
  );
}
