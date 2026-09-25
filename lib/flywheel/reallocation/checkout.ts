// Marketr — Phase 7 F1: checkout-time re-verification + platform spend adapter.
//
// §9.3 / §9.5: the Phase 5 Executor re-verifies at checkout — SRA signature,
// cumulative caps actually consumed, and revocation status AT THE MOMENT OF
// EXECUTION, not just proposal time. Revocation is effective even mid-flight.
//
// Platform spend layer: v1 has no real platform spend APIs. The fixture
// adapter records shifts for tests/E2E; the real adapter throws honest
// not-configured errors. Fake/test mode is the default — no code path here
// can move real money.

import { isApprovalExpired, verifyApprovalReceipt } from "@/lib/media/safety";
import {
  canonicalize,
  createApproval,
  logApprovalEvent,
  verifyApproverReceipts,
  verifyBinding,
  type ApprovalStore,
  type BuyBinding,
  type MediaApproval,
} from "@/lib/media/approvals";
import { evaluatePolicy, type PolicyContext } from "./policy";
import { sraStatusAt, verifySraSignature } from "./sra";
import { AuditLog } from "./audit";
import type { ReallocationStore } from "./store";
import type { ProposalRecord } from "./store";
import type { SraEnvelope } from "./types";

export class NotConfiguredError extends Error {
  constructor(what: string) {
    super(`${what} is not configured: no real platform spend APIs exist in v1 — connect a platform adapter or run in fixture mode.`);
    this.name = "NotConfiguredError";
  }
}

export interface BudgetShift {
  workspaceId: string;
  sourceCampaignRef: string;
  destCampaignRef: string;
  amountCents: number;
  idempotencyKey: string;
  correlationId: string;
}

export interface PlatformSpendAdapter {
  name: string;
  applyBudgetShift(shift: BudgetShift): Promise<{ ok: boolean; platformRef: string }>;
}

/** Fixture adapter: records shifts in memory. Default everywhere. */
export function createFixturePlatformAdapter() {
  const shifts: BudgetShift[] = [];
  const seen = new Set<string>();
  const adapter: PlatformSpendAdapter & { shifts: BudgetShift[] } = {
    name: "fixture",
    shifts,
    async applyBudgetShift(shift) {
      if (seen.has(shift.idempotencyKey)) {
        return { ok: true, platformRef: `fixture:duplicate:${shift.idempotencyKey}` };
      }
      seen.add(shift.idempotencyKey);
      shifts.push(structuredClone(shift));
      return { ok: true, platformRef: `fixture:${shift.idempotencyKey}` };
    },
  };
  return adapter;
}

/** Real adapter: honest not-configured — v1 has no platform spend APIs. */
export function createRealPlatformAdapter(): PlatformSpendAdapter {
  return {
    name: "real",
    async applyBudgetShift() {
      throw new NotConfiguredError("platform budget shift");
    },
  };
}

// ---------------------------------------------------------------------------
// Mode (a): proposal → human approval → Phase 5 per-buy approval object
// ---------------------------------------------------------------------------

export interface MaterializeInput {
  proposal: ProposalRecord;
  /** The client's own ad account — zero custody: Marketr never holds funds. */
  clientAdAccountId: string;
  platform: string;
  /** Separation of duties: the optimizer (system) creates the buy terms; the
   *  human approves them. Never the same identity as the approver. */
  createdBy: string;
  currency?: string;
}

/**
 * Materialize a human-approved mode-(a) proposal as a standard Phase 5
 * per-buy approval object. The binding cryptographically binds the exact
 * source→dest campaign refs, amount, and flight — any drift invalidates the
 * hash and the executor HALTs (TOCTOU kill, Phase 5 §9.3).
 */
export async function materializeModeAApproval(
  approvalStore: ApprovalStore,
  input: MaterializeInput,
  now: Date = new Date(),
): Promise<MediaApproval> {
  const p = input.proposal;
  if (p.mode !== "a") throw new Error("materializeModeAApproval is for mode-(a) proposals only.");
  const flightStart = now.toISOString().slice(0, 10);
  const flightEnd = new Date(+now + 86_400_000).toISOString().slice(0, 10);
  const binding: BuyBinding = {
    platform: input.platform,
    clientAdAccountId: input.clientAdAccountId,
    dealType: "auction",
    lineItems: [
      {
        inventory: p.destCampaignRef,
        pricingModel: "budget_reallocation",
        maxAllowedCents: p.amountCents,
        flightStart,
        flightEnd,
        targetingSnapshot: {
          kind: "f1_budget_shift",
          proposalId: p.id,
          sourceChannel: p.sourceChannel,
          destChannel: p.destChannel,
          sourceCampaignRef: p.sourceCampaignRef,
          marginalRoasDelta: p.marginalRoasDelta,
          decisionRecord: p.decisionRecord,
        },
        creativeIds: [],
        creativeHashes: [],
      },
    ],
    maxTotalSpendCents: p.amountCents,
    currency: (input.currency ?? "USD").toUpperCase(),
    driftTolerance: { pricePct: 0, spendPct: 0 },
    creativeIds: [],
    creativeHashes: [],
    flightStart,
    flightEnd,
    targetingSnapshot: {
      kind: "f1_budget_shift",
      proposalId: p.id,
      sourceChannel: p.sourceChannel,
      destChannel: p.destChannel,
      sourceCampaignRef: p.sourceCampaignRef,
    },
    cancelTerms: "Reallocation shift — cancel before execution; executed shifts are platform-side budget changes.",
    operatorTermsVersion: "f1-v1",
  };
  return createApproval(approvalStore, {
    workspaceId: p.workspaceId,
    type: "buy",
    binding,
    createdBy: input.createdBy,
    createdByMediaRole: "owner",
  });
}

export interface ExecuteMoveDeps {
  store: ReallocationStore;
  adapter: PlatformSpendAdapter;
  notify: (recipients: string[], subject: string, body: string) => Promise<void>;
  now?: Date;
}

export interface ModeACheckoutDeps extends ExecuteMoveDeps {
  approvalStore: ApprovalStore;
}

/**
 * Execute a mode-(a) move: re-verify the Phase 5 approval at checkout
 * (status, binding hash, approver receipts, expiry), then apply the shift.
 * Any failure = HALT, logged on both the approval event log and the F1 audit.
 */
export async function executeModeAMove(
  approvalId: string,
  proposalId: string,
  workspaceId: string,
  actor: string,
  deps: ModeACheckoutDeps,
): Promise<{ executed: boolean; haltReason?: string }> {
  const now = deps.now ?? new Date();
  const audit = new AuditLog(deps.store.audit);
  const corr = `corr_${proposalId}_${now.getTime().toString(36)}`;

  const halt = async (reason: string, diff?: unknown) => {
    await logApprovalEvent(deps.approvalStore, approvalId, workspaceId, "system", "execution_halted", { haltReason: reason, diff });
    await deps.store.updateProposal(proposalId, workspaceId, { status: "rejected" }).catch(() => undefined);
    await audit.append(workspaceId, "execution_halted", "system", { approvalId, proposalId, reason, diff }, corr, now);
    await deps.notify([], "Reallocation move HALTED", reason).catch(() => undefined);
    return { executed: false, haltReason: reason };
  };

  const approval = await deps.approvalStore.get(approvalId, workspaceId);
  if (!approval) return halt("approval not found in workspace");
  if (approval.status !== "approved") return halt(`approval status is "${approval.status}", not "approved"`);
  if (!verifyBinding(approval.binding, approval.bindingHash)) {
    return halt("binding hash mismatch — the approved terms changed (TOCTOU kill)");
  }
  if (!verifyApproverReceipts(approval)) {
    return halt("approver receipts do not verify");
  }
  if (isApprovalExpired(approval.approvalsExpiresAt, now)) {
    return halt("approval expired — never execute expired approvals");
  }

  const li = approval.binding.lineItems[0];
  const ts = (approval.binding.targetingSnapshot ?? {}) as Record<string, unknown>;
  try {
    const res = await deps.adapter.applyBudgetShift({
      workspaceId: approval.workspaceId,
      sourceCampaignRef: String(ts.sourceCampaignRef ?? ""),
      destCampaignRef: li.inventory,
      amountCents: approval.maxSpendCents,
      idempotencyKey: `modeA:${approvalId}`,
      correlationId: corr,
    });
    await logApprovalEvent(deps.approvalStore, approvalId, approval.workspaceId, actor, "executed", {
      platformRef: res.platformRef,
      amountCents: approval.maxSpendCents,
    });
    await deps.store.updateProposal(proposalId, workspaceId, { status: "executed" }).catch(() => undefined);
    await audit.append(approval.workspaceId, "execution", actor, {
      mode: "a", approvalId, proposalId, amountCents: approval.maxSpendCents, platformRef: res.platformRef,
    }, corr, now);
    return { executed: true };
  } catch (err) {
    return halt(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Mode (b): SRA checkout — re-verify everything at execution time
// ---------------------------------------------------------------------------

export interface ModeBCheckoutDeps extends ExecuteMoveDeps {
  sraSecret: string;
  isRevoked: (revocationId: string) => boolean;
  channelBaselinesCents: Map<string, number>;
  lastMoveAt: Map<string, string>;
  explorationChannels: Set<string>;
}

function dayStartIso(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Execute one mode-(b) proposal. Re-verification at checkout:
 *  1. Fresh SRA read (no cached envelope)
 *  2. Status active (expired/revoked = deny — timeout means no)
 *  3. Signature re-verified against the server secret
 *  4. Revocation checked live
 *  5. Consumed caps recomputed from executed shifts (not a counter cache)
 *  6. Full policy re-evaluation
 * Only then does the adapter move budget.
 */
export async function executeModeBShift(
  proposalId: string,
  workspaceId: string,
  actor: string,
  deps: ModeBCheckoutDeps,
): Promise<{ executed: boolean; haltReason?: string }> {
  const now = deps.now ?? new Date();
  const audit = new AuditLog(deps.store.audit);
  const corr = `corr_${proposalId}_${now.getTime().toString(36)}`;

  const proposal = await deps.store.getProposal(proposalId, workspaceId);
  if (!proposal) return { executed: false, haltReason: "proposal not found in workspace" };
  if (proposal.mode !== "b" || !proposal.sraId) {
    return { executed: false, haltReason: "not a mode-(b) proposal with an SRA" };
  }
  if (proposal.status !== "policy_approved") {
    return { executed: false, haltReason: `proposal status "${proposal.status}" — only policy_approved moves execute` };
  }

  const halt = async (reason: string) => {
    await deps.store.updateProposal(proposalId, workspaceId, { status: "policy_denied" });
    await audit.append(workspaceId, "execution_halted", "system", { proposalId, sraId: proposal.sraId, reason }, corr, now);
    await deps.notify([], "SRA move HALTED at checkout", reason).catch(() => undefined);
    return { executed: false, haltReason: reason };
  };

  // 1. Fresh SRA read.
  const sra = await deps.store.getSra(proposal.sraId, workspaceId);
  if (!sra) return halt("SRA not found — timeout means no");

  // 2. Status must be active NOW.
  const status = sraStatusAt(sra as SraEnvelope, now);
  if (status !== "active") return halt(`SRA status=${status} at checkout — timeout means no`);

  // 3. Signature re-verified.
  const signatureValid = verifySraSignature(sra as SraEnvelope, deps.sraSecret);
  if (!signatureValid) return halt("SRA signature does not verify at checkout");

  // 4. Revocation checked live — effective even mid-flight.
  let revoked = false;
  try {
    revoked = deps.isRevoked(sra.revocationId);
  } catch {
    return halt("revocation registry uncheckable at checkout — timeout means no");
  }
  if (revoked) return halt(`SRA revoked (revocation_id=${sra.revocationId}) — halted mid-flight`);

  // 5. Consumed caps recomputed from the executed-shift ledger.
  const dailyShifts = await deps.store.executedShiftsSince(proposal.sraId, workspaceId, dayStartIso(now));
  const weeklyShifts = await deps.store.executedShiftsSince(
    proposal.sraId, workspaceId, new Date(+now - 7 * 86_400_000).toISOString(),
  );
  const consumedDailyCents = dailyShifts.reduce((s, p) => s + Math.abs(p.amountCents), 0);
  const consumedWeeklyCents = weeklyShifts.reduce((s, p) => s + Math.abs(p.amountCents), 0);

  const srcBaseline = deps.channelBaselinesCents.get(proposal.sourceChannel) ?? 0;
  const dstBaseline = deps.channelBaselinesCents.get(proposal.destChannel) ?? 0;
  const projected = new Map<string, number>([
    [proposal.sourceChannel, srcBaseline - proposal.amountCents],
    [proposal.destChannel, dstBaseline + proposal.amountCents],
  ]);

  // 6. Full policy re-evaluation at execution time.
  const policyCtx: PolicyContext = {
    proposal,
    sra: sra as SraEnvelope,
    consumedDailyCents,
    consumedWeeklyCents,
    channelBaselinesCents: deps.channelBaselinesCents,
    projectedBudgetsCents: projected,
    lastMoveAt: deps.lastMoveAt,
    isRevoked: deps.isRevoked,
    signatureValid,
    explorationChannels: deps.explorationChannels,
    now,
  };
  const verdict = evaluatePolicy(policyCtx);
  const decision = await deps.store.appendPolicyDecision(verdict.decision);
  await audit.append(workspaceId, "policy_decision", "policy-engine", {
    proposalId, decision: verdict.decision.decision, reasons: verdict.reasons, checkout: true,
  }, corr, now);
  if (!verdict.allow) {
    return halt(`policy denied at checkout: ${verdict.reasons.join(" | ")} (decision ${decision.id})`);
  }

  try {
    const res = await deps.adapter.applyBudgetShift({
      workspaceId,
      sourceCampaignRef: proposal.sourceCampaignRef,
      destCampaignRef: proposal.destCampaignRef,
      amountCents: proposal.amountCents,
      idempotencyKey: `modeB:${proposalId}`,
      correlationId: corr,
    });
    await deps.store.updateProposal(proposalId, workspaceId, { status: "executed" });
    await audit.append(workspaceId, "execution", actor, {
      mode: "b", proposalId, sraId: proposal.sraId, amountCents: proposal.amountCents,
      consumedDailyCents: consumedDailyCents + proposal.amountCents,
      platformRef: res.platformRef,
    }, corr, now);
    return { executed: true };
  } catch (err) {
    return halt(err instanceof Error ? err.message : String(err));
  }
}

/** Canonical JSON lives with the approval module; re-exported for tests. */
export { canonicalize };
