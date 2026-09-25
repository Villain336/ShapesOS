// Marketr — Phase 7 F1: deterministic Policy Engine.
//
// LLM-PROOF BY CONSTRUCTION: plain TypeScript, no LLM in the auth path. The
// optimizer can propose anything; this engine forwards only what satisfies
// every field of the active SRA. Denials are logged with reasons.
//
// Invariants (spec §9):
// - Timeout means no: expired, revoked, or uncheckable SRA = deny.
// - The engine returns allow/deny only — it has no code path that moves
//   money, writes budgets, or authorizes spend. Breakers likewise.
// - The two-person rule follows the money: cumulative daily movement ≥ $1,000
//   needs two distinct signers, so ten $150 shifts can't dodge the gate.

import { sraStatusAt } from "./sra";
import { SRA_DEFAULTS } from "./sra";
import type { PolicyDecision, ReallocationProposal, SraEnvelope } from "./types";

export interface PolicyContext {
  proposal: ReallocationProposal;
  sra: SraEnvelope;
  /** Rolling sums of |shifts| already executed under this SRA (cents). */
  consumedDailyCents: number;
  consumedWeeklyCents: number;
  /** Baseline daily budgets per channel (cents) for the ±band check. */
  channelBaselinesCents: Map<string, number>;
  /** Projected daily budgets after this move, per channel (cents). */
  projectedBudgetsCents: Map<string, number>;
  /** Last move time per channel, ISO. */
  lastMoveAt: Map<string, string>;
  /** Live revocation registry lookup: true = revoked. */
  isRevoked: (revocationId: string) => boolean;
  /** Signature check against the server secret. False/unavailable = deny. */
  signatureValid: boolean;
  /** Channels flagged as exploration-protected (optimizer must not touch). */
  explorationChannels: Set<string>;
  now: Date;
}

export interface PolicyVerdict {
  allow: boolean;
  reasons: string[];
  decision: Omit<PolicyDecision, "id">;
}

function deny(ctx: PolicyContext, reasons: string[]): PolicyVerdict {
  return {
    allow: false,
    reasons,
    decision: {
      proposalId: ctx.proposal.id,
      workspaceId: ctx.proposal.workspaceId,
      decision: "deny",
      reasons,
      sraId: ctx.sra.id,
      revocationCheckedAt: ctx.now.toISOString(),
    },
  };
}

/**
 * Evaluate one proposal against the SRA. Every check is deterministic and
 * every denial carries machine-readable reasons for the audit log.
 */
export function evaluatePolicy(ctx: PolicyContext): PolicyVerdict {
  const { proposal, sra, now } = ctx;
  const reasons: string[] = [];

  // 1. The SRA must be active RIGHT NOW — expired or revoked = deny.
  const status = sraStatusAt(sra, now);
  if (status !== "active") {
    return deny(ctx, [`sra_not_active: status=${status} (timeout means no)`]);
  }

  // 2. Revocation is checked live on every decision — never cached.
  let revoked = false;
  try {
    revoked = ctx.isRevoked(sra.revocationId);
  } catch {
    return deny(ctx, ["revocation_uncheckable: revocation registry unreachable — timeout means no"]);
  }
  if (revoked) {
    return deny(ctx, [`sra_revoked: revocation_id=${sra.revocationId}`]);
  }

  // 3. Signature must verify — an uncheckable envelope is denied, not trusted.
  if (!ctx.signatureValid) {
    return deny(ctx, ["signature_invalid: SRA signature does not verify — timeout means no"]);
  }

  // 4. Workspace binding: the SRA authorizes this workspace only.
  if (proposal.workspaceId !== sra.workspaceId) {
    reasons.push("workspace_mismatch: SRA does not belong to this workspace");
  }

  // 5. Allowlist: both channels must be explicitly listed.
  for (const ch of [proposal.sourceChannel, proposal.destChannel]) {
    if (!sra.channels.includes(ch)) {
      reasons.push(`allowlist: channel "${ch}" not in SRA allowlist`);
    }
  }

  // 6. Exploration slice: the optimizer must never touch protected spend.
  for (const ch of [proposal.sourceChannel, proposal.destChannel]) {
    if (ctx.explorationChannels.has(ch)) {
      reasons.push(`exploration_floor: channel "${ch}" is exploration-protected`);
    }
  }

  // 7. Per-shift cap.
  if (proposal.amountCents > sra.perShiftCapCents) {
    reasons.push(
      `per_shift_cap: $${(proposal.amountCents / 100).toFixed(2)} > $${(sra.perShiftCapCents / 100).toFixed(2)}`,
    );
  }
  if (proposal.amountCents <= 0) {
    reasons.push("amount_nonpositive: shift amount must be positive");
  }

  // 8. Aggregate caps (sum of |shifts|).
  if (ctx.consumedDailyCents + proposal.amountCents > sra.dailyAggregateCapCents) {
    reasons.push(
      `daily_cap: consumed $${(ctx.consumedDailyCents / 100).toFixed(2)} + $${(proposal.amountCents / 100).toFixed(2)} > $${(sra.dailyAggregateCapCents / 100).toFixed(2)}`,
    );
  }
  if (ctx.consumedWeeklyCents + proposal.amountCents > sra.weeklyAggregateCapCents) {
    reasons.push(
      `weekly_cap: consumed $${(ctx.consumedWeeklyCents / 100).toFixed(2)} + $${(proposal.amountCents / 100).toFixed(2)} > $${(sra.weeklyAggregateCapCents / 100).toFixed(2)}`,
    );
  }

  // 9. Two-person rule follows the money — cumulative, not just per-shift.
  const cumulativeAfter = ctx.consumedDailyCents + proposal.amountCents;
  if (cumulativeAfter >= SRA_DEFAULTS.twoPersonThresholdCents) {
    const distinct = new Set(sra.signerIds).size;
    if (distinct < 2) {
      reasons.push(
        `two_person: cumulative $${(cumulativeAfter / 100).toFixed(2)} ≥ $${(SRA_DEFAULTS.twoPersonThresholdCents / 100).toFixed(0)} requires 2 distinct signers (have ${distinct})`,
      );
    }
  }

  // 10. Per-channel band: projected budgets must stay within ±band% of baseline.
  for (const [ch, projected] of ctx.projectedBudgetsCents) {
    const baseline = ctx.channelBaselinesCents.get(ch);
    if (baseline === undefined || baseline <= 0) {
      reasons.push(`band: no baseline budget for channel "${ch}" — cannot verify ±${sra.perChannelBandPct}% band`);
      continue;
    }
    const driftPct = (Math.abs(projected - baseline) / baseline) * 100;
    if (driftPct > sra.perChannelBandPct) {
      reasons.push(
        `band: channel "${ch}" projected $${(projected / 100).toFixed(2)} drifts ${driftPct.toFixed(1)}% vs baseline $${(baseline / 100).toFixed(2)} (limit ±${sra.perChannelBandPct}%)`,
      );
    }
  }

  // 11. Cool-down per channel.
  for (const ch of [proposal.sourceChannel, proposal.destChannel]) {
    const last = ctx.lastMoveAt.get(ch);
    if (last) {
      const elapsedHrs = (+now - +new Date(last)) / 3_600_000;
      if (elapsedHrs < sra.cooldownHours) {
        reasons.push(
          `cooldown: channel "${ch}" moved ${elapsedHrs.toFixed(1)}h ago — ${sra.cooldownHours}h required`,
        );
      }
    }
  }

  if (reasons.length > 0) {
    return deny(ctx, reasons);
  }
  return {
    allow: true,
    reasons: ["all SRA fields satisfied"],
    decision: {
      proposalId: proposal.id,
      workspaceId: proposal.workspaceId,
      decision: "allow",
      reasons: ["all SRA fields satisfied"],
      sraId: sra.id,
      revocationCheckedAt: now.toISOString(),
    },
  };
}
