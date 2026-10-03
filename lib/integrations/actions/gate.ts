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
import { containsRedactedPlaceholder, REDACTED_PLACEHOLDER, redactArgs, summarizeArgs } from "@/lib/integrations/actions/redact";
import { summarizeAction } from "@/lib/integrations/actions/summarize";
import { describeBulk, extractBulkItems } from "@/lib/integrations/actions/bulk";
import { getComposioBudgetWarning, meterComposioCall, bumpPlatformComposioCalls, checkBudget } from "@/lib/integrations/actions/budget";
import {
  isToolkitEnabled,
  resolveToolkitForTool,
} from "@/lib/integrations/actions/toolkits";
import { ConflictError, ForbiddenError, HttpError, NotFoundError } from "@/lib/api/errors";
import { notifyApprovalDecided, notifyApprovalNeeded } from "@/lib/notifications/producers";

export const APPROVAL_TTL_MS = Number(process.env.ACTION_APPROVAL_TTL_MS ?? 24 * 3600_000);

// pending -> approved|denied|expired; approved -> executed (terminal).
// "executed" is the replay lock: an approval executes AT MOST ONCE.
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "executed";

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
 *
 * Phase 15 slice 3 — toolkit enablement gate (fail-closed, BEFORE anything
 * is classified or stored): when the tool resolves to a KNOWN toolkit that
 * is not enabled for the workspace, the proposal is refused — no approval
 * is created, nothing executes. The v1 five (gmail, google_sheets, slack,
 * hubspot, notion) are enabled-by-default so existing workspaces see zero
 * regression; everything else in the firehose is opt-in per workspace.
 *
 * Tools that resolve to NO known toolkit are NOT refused here: they fall
 * through to the slice-2 conservative floor (unclassified → high-gated,
 * approval + second confirmation required, never auto-executable). The
 * enablement gate is about known-but-disabled toolkits, not about inventing
 * a stricter rule than the conservative doctrine already mandates.
 *
 * A refused proposal is logged (status "denied", executedBy gate:<actor>)
 * and the throw message names the reason.
 */
export async function proposeAction(input: ProposeInput) {
  const toolkitSlug = await resolveToolkitForTool(input.workspaceId, input.toolName);
  const overrides = await getToolTierOverrides(input.workspaceId);
  // Phase 15 slice 6 — the resolved toolkit feeds the auto-read accuracy
  // gate inside classifyAction: a derived low tier escalates to medium
  // (gated, not silent) unless the toolkit passed the sampled tier-accuracy
  // eval (committed, fresh vs the gold set).
  const classified = classifyAction(input.toolName, overrides, { appKey: input.appKey, toolkitSlug });
  // Refuse fail-closed ONLY for known-but-disabled toolkits (slice 3). A
  // tool that resolves to no known toolkit falls through to the slice-2
  // conservative floor (unclassified → high-gated, never auto-executed).
  const toolkitAllowed =
    toolkitSlug === null || (await isToolkitEnabled(input.workspaceId, toolkitSlug));
  if (!toolkitAllowed) {
    const reason = `toolkit "${toolkitSlug}" is not enabled for this workspace`;
    await logAction({
      workspaceId: input.workspaceId,
      appKey: input.appKey,
      toolName: input.toolName,
      riskTier: classified.tier,
      toolkitSlug,
      resultSummary: { toolkitGateRefusal: reason },
      status: "denied",
      executedBy: `gate:${input.proposedBy}`,
    });
    throw new ForbiddenError(
      `Refused by toolkit gate: ${reason}. No approval was created and nothing executed.`,
    );
  }
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
          detail: `tier=${classified.tier}${classified.overridden ? " (override)" : ""}${classified.clamped ? " — override clamped at conservative floor" : ""}${classified.draftCreator ? " draft-creator" : ""}${classified.classified ? "" : " — unclassified (conservative high)"}`,
        })),
      },
      select: { id: true, status: true, riskTier: true, plainSummary: true, expiresAt: true },
    }),
  );
  // Phase 3 (J): gated actions land in the "needs you" inbox — tell the
  // approvers (best-effort, after the write committed).
  if (!classified.autoExecutable) {
    await notifyApprovalNeeded({
      workspaceId: input.workspaceId,
      source: "integration",
      sourceId: approval.id,
      title: approval.plainSummary,
      href: "/dashboard/actions",
      requestedBy: input.proposedBy,
    });
  }
  return { approval, classified };
}

/**
 * Who requested an approval: the actor of its server-written "proposed"
 * audit event (proposeAction sets it from the session user or the agent
 * identity — never from the client body).
 */
export function requesterOf(auditTrail: unknown): string | null {
  const arr = Array.isArray(auditTrail) ? (auditTrail as AuditEvent[]) : [];
  return arr.find((e) => e?.event === "proposed")?.actor ?? null;
}

/** True when `userId` is the requester (also "<userId> (playbook:…)" forms). */
export function isRequester(requester: string | null, userId: string): boolean {
  if (!requester || !userId) return false;
  return requester === userId || requester.startsWith(`${userId} `);
}

/**
 * Separation of duties: is there an editor+ member other than the requester
 * who could approve instead? A solo workspace (nobody else can approve) may
 * self-approve — recorded as such in the audit trail.
 */
async function hasOtherApprover(tx: Prisma.TransactionClient, workspaceId: string, requesterId: string) {
  const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { ownerUserId: true } });
  if (ws?.ownerUserId && ws.ownerUserId !== requesterId) return true;
  const other = await tx.workspaceMember.findFirst({
    where: {
      workspaceId,
      userId: { not: null, notIn: [requesterId] },
      role: { in: ["editor", "admin", "owner"] },
    },
    select: { id: true },
  });
  return other !== null;
}

export class SeparationOfDutiesError extends Error {
  readonly status = 403;
  constructor() {
    super("You requested this action, so another editor must approve it (separation of duties).");
    this.name = "SeparationOfDutiesError";
  }
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
  // Phase 15 slice 6 — resolve the toolkit BEFORE the transaction (the
  // re-classify below must carry it for the auto-read gate; resolving
  // inside the tx would nest withWorkspaceScope calls).
  let reclassToolkitSlug: string | null | undefined;
  if (input.editedArgs) {
    const lite = await withWorkspaceScope(input.workspaceId, (tx) =>
      tx.composioActionApproval.findFirst({
        where: { id: input.approvalId, workspaceId: input.workspaceId },
        select: { toolName: true },
      }),
    );
    if (!lite) throw new NotFoundError("Approval not found");
    reclassToolkitSlug = await resolveToolkitForTool(input.workspaceId, lite.toolName);
  }
  let requestedBy: string | null = null;
  const decided = await withWorkspaceScope(input.workspaceId, async (tx) => {
    const approval = await tx.composioActionApproval.findFirst({
      where: { id: input.approvalId, workspaceId: input.workspaceId },
    });
    if (!approval) throw new NotFoundError("Approval not found");
    requestedBy = requesterOf(approval.auditTrail);
    if (approval.status !== "pending") {
      throw new ConflictError(`Approval is ${approval.status}, not pending`);
    }
    if (approval.expiresAt.getTime() < Date.now()) {
      const expired = await tx.composioActionApproval.update({
        where: { id: approval.id, workspaceId: input.workspaceId },
        data: {
          status: "expired",
          auditTrail: toJson(trail(approval.auditTrail, { at: nowIso(), actor: "system", event: "expired" })),
        },
        select: { id: true, status: true },
      });
      throw new ConflictError("Approval expired before decision");
    }
    // Separation of duties (Phase 1): the requester cannot approve their own
    // action unless nobody else in the workspace can. Denying (withdrawing)
    // your own request is always allowed.
    let selfApproved = false;
    if (input.decision === "approved" && isRequester(requesterOf(approval.auditTrail), input.decidedBy)) {
      if (await hasOtherApprover(tx, input.workspaceId, input.decidedBy)) throw new SeparationOfDutiesError();
      selfApproved = true;
    }
    const redacted = input.editedArgs ? redactArgs(input.editedArgs) : undefined;
    // Edit-before-approve reclassifies with FRESH overrides (slice 5): the
    // tier is re-derived so an edit can't silently change the action's risk
    // profile. The conservative floor in classifyAction still holds.
    const reclassified = input.editedArgs
      ? classifyAction(approval.toolName, await getToolTierOverrides(input.workspaceId), { appKey: approval.appKey, toolkitSlug: reclassToolkitSlug })
      : null;
    const tierChanged = reclassified !== null && reclassified.tier !== approval.riskTier;
    const updated = await tx.composioActionApproval.update({
      where: { id: approval.id, workspaceId: input.workspaceId },
      data: {
        status: input.decision === "approved" ? "approved" : "denied",
        decidedBy: input.decidedBy,
        decidedAt: new Date(),
        decisionReason: input.reason?.trim() || null,
        ...(redacted
          ? {
              proposedArgs: toJson(redacted),
              plainSummary: summarizeAction(approval.appKey, approval.toolName, redacted),
              ...(tierChanged ? { riskTier: (reclassified as { tier: RiskTier }).tier } : {}),
            }
          : {}),
        auditTrail: toJson(trail(approval.auditTrail, {
          at: nowIso(),
          actor: input.decidedBy,
          event: input.decision,
          detail:
            [
              input.reason?.trim() ||
                (redacted
                  ? `args edited before approve${tierChanged ? ` — tier ${approval.riskTier} -> ${(reclassified as { tier: RiskTier }).tier}` : ""}`
                  : undefined),
              selfApproved ? "self-approved: no other approver in this workspace" : undefined,
            ]
              .filter(Boolean)
              .join(" — ") || undefined,
        })),
      },
      select: { id: true, status: true, riskTier: true, plainSummary: true },
    });
    return updated;
  });
  await notifyApprovalDecided({
    workspaceId: input.workspaceId,
    source: "integration",
    sourceId: decided.id,
    title: decided.plainSummary,
    decision: input.decision === "approved" ? "approved" : "denied",
    decidedBy: input.decidedBy,
    requestedBy,
    href: "/dashboard/actions",
  });
  return decided;
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
  if (!approval) throw new NotFoundError("Approval not found");
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
          where: { id: row.id, workspaceId: wsId },
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
  /** Explicit second confirmation for HIGH-tier (destructive) actions —
   *  the UI collects it in a confirm dialog. Required, never defaulted. */
  destructiveConfirm?: boolean;
  /** For bulk actions: the item count the human reviewed. Must match the
   *  proposed args exactly — a different set fails closed. */
  confirmedBulkCount?: number;
  http?: ComposioHttp;
}

/**
 * THE choke point for gated actions. Loads the approval, requires
 * approved + unexpired, executes via Composio, and ALWAYS writes a
 * ComposioActionLog — nothing executes without a log entry.
 *
 * Trust ladder (slice 5):
 *  - replay lock: status flips approved -> executed ATOMICALLY (conditional
 *    update); a second execute attempt finds no "approved" row and throws.
 *  - high tier: requires destructiveConfirm (explicit second confirmation).
 *  - bulk: confirmedBulkCount must equal the proposed item count.
 *  - failed execution reverts to "approved" (retry allowed) with an audit
 *    event; the failure is still logged.
 */
export async function executeApproved(input: ExecuteApprovedInput) {
  const approval = await withWorkspaceScope(input.workspaceId, (tx) =>
    tx.composioActionApproval.findFirst({
      where: { id: input.approvalId, workspaceId: input.workspaceId },
    }),
  );
  if (!approval) throw new NotFoundError("Approval not found");
  if (approval.status === "executed") {
    throw new ConflictError("Cannot execute: approval already executed (replay blocked)");
  }
  if (approval.status !== "approved") {
    throw new ConflictError(`Cannot execute: approval is ${approval.status} (must be approved)`);
  }
  if (approval.expiresAt.getTime() < Date.now()) {
    await expireStaleApprovals(input.workspaceId);
    throw new ConflictError("Cannot execute: approval expired");
  }
  const tier = approval.riskTier as RiskTier;
  if (tier === "high" && input.destructiveConfirm !== true) {
    throw new ConflictError(
      "Cannot execute: destructive (high-tier) actions require an explicit second confirmation",
    );
  }
  const proposedArgs = (approval.proposedArgs as Record<string, unknown>) ?? {};
  // Fail closed (Tico, 2026-09-28): the gate stores secrets redacted, so a
  // stored placeholder can never be executed — running a tool with the
  // literal "[redacted]" string where a credential was would silently
  // misfire. Refuse BEFORE the atomic claim so the approval stays
  // "approved" and can be fixed via edit-before-approve (or denied).
  // Credential-bearing tools need the encrypted-secrets path (planned).
  if (containsRedactedPlaceholder(proposedArgs)) {
    throw new ConflictError(
      `Cannot execute: stored arguments contain the ${REDACTED_PLACEHOLDER} placeholder — ` +
        "the gate stores secrets redacted and will not run a tool with placeholder values. " +
        "Use edit-before-approve to remove the secret-bearing argument, or deny this approval. " +
        "Credential-bearing tools require the planned encrypted-secrets path.",
    );
  }
  const bulk = extractBulkItems(proposedArgs);
  if (bulk && input.confirmedBulkCount !== bulk.count) {
    throw new ConflictError(
      `Cannot execute: bulk action targets ${bulk.count} items via "${bulk.field}" — ` +
        `the confirmed count (${input.confirmedBulkCount ?? "none"}) must match what was reviewed`,
    );
  }
  // Phase 15 slice 4: per-workspace call budget (spec §5). Hard cap =
  // fail-closed refusal BEFORE the atomic claim (the approval stays
  // "approved" so it can run next month; nothing executes, the refusal is
  // recorded as a "denied" log row — never counted as an execution). Soft
  // cap never blocks: the threshold crossing surfaces as a warning on the
  // execution log instead.
  const budgetState = await checkBudget(input.workspaceId);
  if (budgetState.blocked) {
    const reason =
      `workspace Composio call budget exhausted (hard cap): ` +
      `${budgetState.usage}/${budgetState.budget} tool calls used this month. ` +
      `No further executions until the budget resets or is raised.`;
    await logAction({
      workspaceId: input.workspaceId,
      approvalId: approval.id,
      appKey: approval.appKey,
      toolName: approval.toolName,
      riskTier: tier,
      toolkitSlug: await resolveToolkitForTool(input.workspaceId, approval.toolName),
      resultSummary: { budgetRefusal: reason },
      status: "denied",
      executedBy: `gate:${input.executedBy}`,
    });
    throw new ConflictError(`Cannot execute: ${reason}`);
  }
  // Atomic claim: approved -> executed. Concurrent/second attempts affect
  // 0 rows and fail closed.
  const claimed = await withWorkspaceScope(input.workspaceId, (tx) =>
    tx.composioActionApproval.updateMany({
      where: { id: approval.id, workspaceId: input.workspaceId, status: "approved" },
      data: {
        status: "executed",
        auditTrail: toJson(trail(approval.auditTrail, {
          at: nowIso(),
          actor: input.executedBy,
          event: "execution_claimed",
          detail:
            tier === "high"
              ? `destructive confirmed${bulk ? `; bulk ${describeBulk(bulk)}` : ""}`
              : bulk
                ? `bulk ${describeBulk(bulk)}`
                : undefined,
        })),
      },
    }),
  );
  if (claimed.count !== 1) {
    throw new ConflictError("Cannot execute: approval was already claimed (replay blocked)");
  }

  const connectedAccountId = await requireConnectedEntity(input.workspaceId, approval.appKey);

  // Phase 14 slice 10: cost warning BEFORE the call. Advisory only — the
  // action still executes; the credit ledger's own caps handle enforcement.
  const budgetWarning = await getComposioBudgetWarning({
    workspaceId: input.workspaceId,
    toolName: approval.toolName,
  });

  const started = Date.now();
  let status: "success" | "failed" = "success";
  let resultSummary: Record<string, unknown> = {};
  try {
    const res = await executeComposioTool(
      {
        slug: approval.toolName,
        connectedAccountId,
        args: proposedArgs,
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
  // Phase 15 slice 4: toolkit attribution on the execution log (spec §4);
  // resolve once — the log row is the per-toolkit cost source of truth.
  const executedToolkitSlug = await resolveToolkitForTool(input.workspaceId, approval.toolName);
  const workspaceBudgetWarning = budgetState.warning;
  await logAction({
    workspaceId: input.workspaceId,
    approvalId: approval.id,
    appKey: approval.appKey,
    toolName: approval.toolName,
    riskTier: tier,
    toolkitSlug: executedToolkitSlug,
    argsSummary: proposedArgs,
    resultSummary: {
      ...resultSummary,
      ...(budgetWarning ? { budgetWarning } : null),
      ...(workspaceBudgetWarning ? { workspaceBudgetWarning } : null),
    },
    latencyMs: Date.now() - started,
    status,
    executedBy: input.executedBy,
  });
  if (status === "failed") {
    // Revert to approved so a human can retry after fixing the cause.
    // The failure stays in the log + audit trail; the replay lock only
    // blocks SUCCESSFUL double-execution.
    const currentTrail = await withWorkspaceScope(input.workspaceId, (tx) =>
      tx.composioActionApproval.findFirst({
        where: { id: approval.id, workspaceId: input.workspaceId },
        select: { auditTrail: true },
      }),
    );
    await withWorkspaceScope(input.workspaceId, (tx) =>
      tx.composioActionApproval.updateMany({
        where: { id: approval.id, workspaceId: input.workspaceId, status: "executed" },
        data: {
          status: "approved",
          auditTrail: toJson(trail(currentTrail?.auditTrail ?? [], {
            at: nowIso(),
            actor: "system",
            event: "execution_failed",
            detail: "reverted to approved for retry",
          })),
        },
      }),
    );
    // Upstream (Composio/app) failure: 502 with the truncated result summary.
    throw new HttpError(502, `Action failed: ${JSON.stringify(resultSummary).slice(0, 200)}`);
  }
  return { ok: true, latencyMs: Date.now() - started };
}

export interface LogActionInput {
  workspaceId: string;
  approvalId?: string;
  appKey: string;
  toolName: string;
  riskTier: RiskTier;
  /** Toolkit attribution for per-toolkit cost breakdown (spec §5). */
  toolkitSlug?: string | null;
  argsSummary?: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
  latencyMs?: number;
  status: "success" | "failed" | "denied" | "expired";
  executedBy: string;
}

/** Write the audit/metering record. Every execution path calls this. */
export async function logAction(input: LogActionInput) {
  // Denied/expired rows are not executions — never metered, never counted.
  const executed = input.status === "success" || input.status === "failed";
  const row = await withWorkspaceScope(input.workspaceId, async (tx) => {
    const created = await tx.composioActionLog.create({
      data: {
        workspaceId: input.workspaceId,
        approvalId: input.approvalId,
        appKey: input.appKey,
        toolName: input.toolName.toUpperCase(),
        riskTier: input.riskTier,
        toolkitSlug: input.toolkitSlug ?? null,
        argsSummary: toJson(summarizeArgs(input.argsSummary ?? {})),
        resultSummary: toJson(input.resultSummary ?? {}),
        latencyMs: input.latencyMs,
        status: input.status,
        executedBy: input.executedBy,
      },
      select: { id: true },
    });
    // Phase 14 slice 10: platform free-tier counter, same transaction as the
    // audit row — the count can never drift from the log.
    if (executed) await bumpPlatformComposioCalls(tx);
    return created;
  });
  // Phase 14 slice 10: meter executed calls through the credit ledger.
  if (executed) {
    await meterComposioCall({
      workspaceId: input.workspaceId,
      logId: row.id,
      executedBy: input.executedBy,
    });
  }
  return row;
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
        toolkitSlug: true,
        status: true,
        executedBy: true,
        latencyMs: true,
        createdAt: true,
      },
    }),
  );
}
