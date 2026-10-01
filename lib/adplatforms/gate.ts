// Marketr — Phase 18 slice 1: the ad-spend approval gate.
//
// propose → approve/deny → execute, fail-closed. SpendProposal is THE gate:
// no launch, pause, or budget change executes without a matching, unexpired,
// scope-hash-identical SpendApproval.
//
// Fail-closed conditions (every bypass attempt throws AdsGateError and the
// mutation never runs):
//   - missing approval
//   - proposal rejected / expired / already executed
//   - approval bound to a different scope hash ("approve $100, execute
//     $10,000" is impossible — canonical JSON compare)
//   - workspace mismatch between proposal, approval, and execution
//   - adjust_budget executed directly: budget changes must arrive as a NEW
//     proposal with their own approval
//
// Scope hashing reuses the canonical-JSON scheme from lib/authority/approvals
// (the same scheme the Phase 17 ops gate uses for binding compare).

import { createHash } from "crypto";
import { canonicalize } from "@/lib/authority/approvals";
import type { AdsPlatformKey } from "./types";

export class AdsGateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdsGateError";
    this.code = code;
  }
}

/** Proposals die un-acted-upon after this long so a stale approval can never fire. */
export const SPEND_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export type SpendProposalKind = "launch" | "pause" | "budget_change" | "new_flight";
export type SpendProposalStatus = "pending" | "approved" | "rejected" | "executed" | "expired";

export interface SpendProposal {
  id: string;
  workspaceId: string;
  kind: SpendProposalKind;
  action: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  scopeHash: string;
  status: SpendProposalStatus;
  proposedBy: string;
  proposedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  expiresAt: Date;
}

export interface SpendApproval {
  id: string;
  workspaceId: string;
  proposalId: string;
  approver: string;
  decidedAt: Date;
  scopeHash: string;
}

// ---------------------------------------------------------------------------
// Ports (implemented by ./store.ts against Prisma; stubbed in tests)
// ---------------------------------------------------------------------------

export interface SpendProposalStore {
  create(input: {
    workspaceId: string;
    kind: SpendProposalKind;
    action: string;
    targetType: string;
    targetId: string;
    payload: Record<string, unknown>;
    scopeHash: string;
    proposedBy: string;
    expiresAt: Date;
  }): Promise<SpendProposal>;
  get(id: string): Promise<SpendProposal | null>;
  setStatus(
    id: string,
    status: SpendProposalStatus,
    decidedBy?: string,
  ): Promise<SpendProposal>;
}

export interface SpendApprovalStore {
  create(input: {
    workspaceId: string;
    proposalId: string;
    approver: string;
    scopeHash: string;
  }): Promise<SpendApproval>;
  getByProposalId(proposalId: string): Promise<SpendApproval | null>;
}

// ---------------------------------------------------------------------------
// Scope hashing
// ---------------------------------------------------------------------------

/** SHA-256 over the canonical JSON of the execution payload. */
export function scopeHashFor(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface ProposeSpendInput {
  workspaceId: string;
  kind: SpendProposalKind;
  /** launch | pause | adjust_budget — must match the governed action. */
  action: string;
  targetType: "campaign" | "group";
  targetId: string;
  payload: Record<string, unknown>;
  proposedBy: string;
  platformKey?: AdsPlatformKey;
}

/**
 * Draft a spend proposal. Creates no platform object and spends nothing —
 * proposals are free by design so humans and agents can draft safely.
 */
export async function proposeSpendAction(
  proposals: SpendProposalStore,
  input: ProposeSpendInput,
): Promise<SpendProposal> {
  if (!input.workspaceId) throw new AdsGateError("INVALID_INPUT", "workspaceId is required");
  if (!input.targetId) throw new AdsGateError("INVALID_INPUT", "targetId is required");
  if (!["launch", "pause", "adjust_budget", "new_flight"].includes(input.action)) {
    throw new AdsGateError("INVALID_INPUT", `Unknown spend action: ${input.action}`);
  }
  const scopeHash = scopeHashFor(input.payload);
  return proposals.create({
    workspaceId: input.workspaceId,
    kind: input.kind,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    payload: input.payload,
    scopeHash,
    proposedBy: input.proposedBy,
    expiresAt: new Date(Date.now() + SPEND_PROPOSAL_TTL_MS),
  });
}

/**
 * Human approves a pending proposal. Mints the immutable SpendApproval bound
 * to the proposal's scope hash. A changed mind is a NEW proposal — approvals
 * are never edited or deleted.
 */
export async function approveSpendAction(
  proposals: SpendProposalStore,
  approvals: SpendApprovalStore,
  proposalId: string,
  approver: string,
): Promise<{ proposal: SpendProposal; approval: SpendApproval }> {
  const existing = await approvals.getByProposalId(proposalId);
  if (existing) {
    throw new AdsGateError("ALREADY_DECIDED", `Proposal ${proposalId} already has an approval`);
  }
  const proposal = await getActionableProposal(proposals, proposalId, "approve");
  const approval = await approvals.create({
    workspaceId: proposal.workspaceId,
    proposalId: proposal.id,
    approver,
    scopeHash: proposal.scopeHash,
  });
  const updated = await proposals.setStatus(proposalId, "approved", approver);
  return { proposal: updated, approval };
}

/** Human rejects a pending proposal. Rejected proposals can never execute. */
export async function rejectSpendAction(
  proposals: SpendProposalStore,
  proposalId: string,
  decidedBy: string,
): Promise<SpendProposal> {
  const proposal = await getActionableProposal(proposals, proposalId, "reject");
  return proposals.setStatus(proposal.id, "rejected", decidedBy);
}

async function getActionableProposal(
  proposals: SpendProposalStore,
  proposalId: string,
  verb: string,
): Promise<SpendProposal> {
  const proposal = await proposals.get(proposalId);
  if (!proposal) {
    throw new AdsGateError("PROPOSAL_NOT_FOUND", `Cannot ${verb}: proposal ${proposalId} not found`);
  }
  if (proposal.status !== "pending") {
    throw new AdsGateError(
      "PROPOSAL_NOT_PENDING",
      `Cannot ${verb}: proposal ${proposalId} is ${proposal.status}`,
    );
  }
  if (proposal.expiresAt.getTime() <= Date.now()) {
    throw new AdsGateError("PROPOSAL_EXPIRED", `Cannot ${verb}: proposal ${proposalId} expired`);
  }
  return proposal;
}

// ---------------------------------------------------------------------------
// Execution — the ONLY path that touches platform APIs / spends money
// ---------------------------------------------------------------------------

export interface ExecuteSpendInput {
  workspaceId: string;
  proposalId: string;
  /** The exact payload about to execute — must be scope-hash-identical. */
  payload: Record<string, unknown>;
}

/**
 * Verify a spend execution fail-closed, then hand the verified payload to
 * the platform executor. Throws AdsGateError on ANY mismatch — the executor
 * callback never runs.
 */
export async function executeSpendAction<T>(
  proposals: SpendProposalStore,
  approvals: SpendApprovalStore,
  input: ExecuteSpendInput,
  executor: (verified: {
    proposal: SpendProposal;
    approval: SpendApproval;
    payload: Record<string, unknown>;
  }) => Promise<T>,
): Promise<T> {
  const proposal = await proposals.get(input.proposalId);
  if (!proposal) {
    throw new AdsGateError("PROPOSAL_NOT_FOUND", "Execution refused: proposal not found");
  }
  if (proposal.workspaceId !== input.workspaceId) {
    throw new AdsGateError("WORKSPACE_MISMATCH", "Execution refused: workspace mismatch");
  }
  if (proposal.status === "executed") {
    throw new AdsGateError("ALREADY_EXECUTED", "Execution refused: proposal already executed (replay blocked)");
  }
  if (proposal.status !== "approved") {
    throw new AdsGateError(
      "NOT_APPROVED",
      `Execution refused: proposal is ${proposal.status}, not approved`,
    );
  }
  if (proposal.expiresAt.getTime() <= Date.now()) {
    throw new AdsGateError("PROPOSAL_EXPIRED", "Execution refused: proposal expired");
  }
  const approval = await approvals.getByProposalId(proposal.id);
  if (!approval) {
    throw new AdsGateError("APPROVAL_MISSING", "Execution refused: no SpendApproval for this proposal");
  }
  if (approval.workspaceId !== proposal.workspaceId) {
    throw new AdsGateError("WORKSPACE_MISMATCH", "Execution refused: approval workspace mismatch");
  }
  // The binding: what executes must be byte-identical to what was approved.
  const executionHash = scopeHashFor(input.payload);
  if (executionHash !== proposal.scopeHash || approval.scopeHash !== proposal.scopeHash) {
    throw new AdsGateError(
      "SCOPE_HASH_MISMATCH",
      "Execution refused: execution payload differs from the approved scope",
    );
  }

  const result = await executor({ proposal, approval, payload: input.payload });
  await proposals.setStatus(proposal.id, "executed");
  return result;
}

/**
 * Budget changes ALWAYS arrive as a new proposal — there is no in-place
 * budget edit path. The returned proposal still needs approveSpendAction +
 * executeSpendAction before anything changes on the platform.
 */
export async function proposeBudgetChange(
  proposals: SpendProposalStore,
  input: Omit<ProposeSpendInput, "kind" | "action">,
): Promise<SpendProposal> {
  return proposeSpendAction(proposals, {
    ...input,
    kind: "budget_change",
    action: "adjust_budget",
  });
}
