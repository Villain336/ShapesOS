// Marketr — Phase 7 F1: Standing Reallocation Approval (SRA).
//
// The SRA is a human-signed, bounded, expiring envelope — a pool-cap object,
// NOT standing autonomous authority. Mode (b) executes only inside an
// active, unexpired, unrevoked SRA checked at execution time (not just
// proposal time). Explicit opt-in per workspace; defaults to disabled.
//
// Defaults (spec §2/F1, open question 1 approved): ±10% per-channel band,
// ~15% daily / ~25% weekly aggregate caps, $1,000 per-shift cap with the
// two-person rule at $1,000 cumulative, 72h cool-down, ≤30d expiry.

import { sha256Hex } from "@/lib/media/safety";
import { canonicalize } from "@/lib/media/approvals";
import type { SraEnvelope, SraStatus } from "./types";

export const SRA_DEFAULTS = {
  perShiftCapCents: 100_000, // $1,000
  dailyAggregateCapPct: 0.15, // ~15% of pool
  weeklyAggregateCapPct: 0.25, // ~25% of pool
  perChannelBandPct: 10, // ±10% vs baseline
  explorationFloorPct: 0.15, // 10–20% protected
  cooldownHours: 72, // Meta scaling ladder
  maxValidityDays: 30, // ≤30d, then re-sign
  twoPersonThresholdCents: 100_000, // cumulative too — ten $150 shifts can't dodge the gate
} as const;

export interface SraCreateInput {
  workspaceId: string;
  name: string;
  channels: string[];
  perShiftCapCents?: number;
  dailyAggregateCapCents?: number;
  weeklyAggregateCapCents?: number;
  perChannelBandPct?: number;
  explorationFloorPct?: number;
  cooldownHours?: number;
  validFrom?: string; // ISO; defaults to now
  validUntil: string; // ISO — mandatory
  signerIds: string[];
  createdBy: string;
  /** Pool size (daily budget across allowlisted channels, cents) used to
   *  derive default aggregate caps. Required when caps aren't explicit. */
  poolDailyBudgetCents?: number;
}

export class SraViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SraViolationError";
  }
}

/** Deterministic envelope → signature hash. The secret never leaves the server. */
export function signSraEnvelope(unsigned: Omit<SraEnvelope, "id" | "signatureHash" | "status" | "createdAt" | "revokedAt" | "revokedBy">, secret: string): string {
  return sha256Hex(canonicalize({ ...unsigned, secretMarker: "sra-v1" }) + "::" + secret);
}

export function verifySraSignature(sra: SraEnvelope, secret: string | undefined): boolean {
  if (!secret) return false; // uncheckable = deny (timeout means no)
  const { id: _id, signatureHash: _sig, status: _st, createdAt: _ca, revokedAt: _ra, revokedBy: _rb, ...unsigned } = sra;
  const expected = signSraEnvelope(unsigned as Omit<SraEnvelope, "id" | "signatureHash" | "status" | "createdAt" | "revokedAt" | "revokedBy">, secret);
  if (expected.length !== sra.signatureHash.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sra.signatureHash.charCodeAt(i);
  return diff === 0;
}

/** Build + validate an SRA. Throws SraViolationError on any invalid field. */
export function createSraEnvelope(input: SraCreateInput, secret: string, now: Date = new Date()): SraEnvelope {
  if (!secret) throw new SraViolationError("SRA signing requires a server secret.");
  if (!input.name?.trim()) throw new SraViolationError("SRA requires a name.");
  if (!input.channels || input.channels.length === 0) {
    throw new SraViolationError("SRA requires an explicit channel allowlist — none means no channels, never all channels.");
  }
  const from = input.validFrom ? new Date(input.validFrom) : now;
  const until = new Date(input.validUntil);
  if (Number.isNaN(+until)) throw new SraViolationError("validUntil must be a valid ISO date.");
  if (+until <= +from) throw new SraViolationError("validUntil must be after validFrom.");
  const validityDays = (+until - +from) / 86_400_000;
  if (validityDays > SRA_DEFAULTS.maxValidityDays) {
    throw new SraViolationError(`SRA expiry is mandatory at ≤${SRA_DEFAULTS.maxValidityDays} days — perpetual or auto-renewing SRAs are forbidden.`);
  }
  if (!input.signerIds || input.signerIds.length === 0) {
    throw new SraViolationError("SRA requires at least one human signer.");
  }
  const uniqueSigners = [...new Set(input.signerIds)];

  const pool = input.poolDailyBudgetCents ?? 0;
  const perShiftCapCents = input.perShiftCapCents ?? SRA_DEFAULTS.perShiftCapCents;
  if (perShiftCapCents > SRA_DEFAULTS.perShiftCapCents) {
    throw new SraViolationError(`per_shift_cap above $${SRA_DEFAULTS.perShiftCapCents / 100} requires the two-person path at creation — widen deliberately, not by default.`);
  }
  const dailyAggregateCapCents =
    input.dailyAggregateCapCents ?? Math.round(pool * SRA_DEFAULTS.dailyAggregateCapPct);
  const weeklyAggregateCapCents =
    input.weeklyAggregateCapCents ?? Math.round(pool * SRA_DEFAULTS.weeklyAggregateCapPct);
  if (dailyAggregateCapCents <= 0 || weeklyAggregateCapCents <= 0) {
    throw new SraViolationError("Aggregate caps must be positive — supply poolDailyBudgetCents or explicit caps.");
  }
  const perChannelBandPct = input.perChannelBandPct ?? SRA_DEFAULTS.perChannelBandPct;
  if (perChannelBandPct <= 0 || perChannelBandPct > 50) {
    throw new SraViolationError("per_channel_band_pct must be within (0, 50].");
  }
  const explorationFloorPct = input.explorationFloorPct ?? SRA_DEFAULTS.explorationFloorPct;
  if (explorationFloorPct < 0.1 || explorationFloorPct > 0.2) {
    throw new SraViolationError("exploration_floor_pct must stay within 10–20%.");
  }
  const cooldownHours = input.cooldownHours ?? SRA_DEFAULTS.cooldownHours;
  if (cooldownHours < 24) throw new SraViolationError("cooldown_hours below 24h defeats the scaling ladder.");

  // The two-person rule follows the money: cumulative ≥$1k needs two signers
  // even if no single shift reaches $1k.
  const cumulativeHeadroom = Math.min(dailyAggregateCapCents, perShiftCapCents * 10);
  if (cumulativeHeadroom >= SRA_DEFAULTS.twoPersonThresholdCents && uniqueSigners.length < 2) {
    throw new SraViolationError(
      `Cumulative movement can reach $${(cumulativeHeadroom / 100).toFixed(0)} ≥ $${SRA_DEFAULTS.twoPersonThresholdCents / 100} — two distinct human signers required.`,
    );
  }

  const unsigned = {
    workspaceId: input.workspaceId,
    name: input.name.trim(),
    channels: [...input.channels],
    perShiftCapCents,
    dailyAggregateCapCents,
    weeklyAggregateCapCents,
    perChannelBandPct,
    explorationFloorPct,
    cooldownHours,
    validFrom: from.toISOString(),
    validUntil: until.toISOString(),
    revocationId: `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    signerIds: uniqueSigners,
    createdBy: input.createdBy,
  };
  const createdAt = now.toISOString();
  const envelope: SraEnvelope = {
    ...unsigned,
    id: "",
    status: "active",
    signatureHash: "",
    createdAt,
    revokedAt: null,
    revokedBy: null,
  };
  envelope.signatureHash = signSraEnvelope(unsigned, secret);
  return envelope;
}

/** Instant revocation: flips the envelope to denied. Effective mid-flight via
 *  checkout-time re-verification (the executor re-checks status, not a cache). */
export function revokeSra(sra: SraEnvelope, actor: string, now: Date = new Date()): SraEnvelope {
  if (sra.status === "revoked") return sra;
  return { ...sra, status: "revoked", revokedAt: now.toISOString(), revokedBy: actor };
}

/** Expiry sweep helper: expired envelopes are denied, never executed. */
export function sraStatusAt(sra: SraEnvelope, now: Date = new Date()): SraStatus {
  if (sra.status === "revoked") return "revoked";
  return +new Date(sra.validUntil) <= +now ? "expired" : "active";
}

/** Plain-language consequences for the opt-in UX. */
export function sraConsequences(sra: SraEnvelope): string[] {
  return [
    `The agent may move up to $${(sra.perShiftCapCents / 100).toFixed(0)} per shift between: ${sra.channels.join(", ")}.`,
    `No more than $${(sra.dailyAggregateCapCents / 100).toFixed(0)} moved per day, $${(sra.weeklyAggregateCapCents / 100).toFixed(0)} per rolling 7 days.`,
    `Each channel stays within ±${sra.perChannelBandPct}% of its baseline budget; ${Math.round(sra.explorationFloorPct * 100)}% of budget is protected test spend the agent cannot touch.`,
    `At least ${sra.cooldownHours}h between moves on the same channel.`,
    `This approval expires ${new Date(sra.validUntil).toLocaleDateString()} and does NOT auto-renew. You can revoke it instantly at any time.`,
    sra.signerIds.length >= 2
      ? `Signed by ${sra.signerIds.length} humans (two-person rule satisfied for ≥$${SRA_DEFAULTS.twoPersonThresholdCents / 100} cumulative movement).`
      : `Signed by 1 human — cumulative movement stays under $${SRA_DEFAULTS.twoPersonThresholdCents / 100}.`,
    `The agent can only move budget between campaigns — never inside PMax/Advantage+, never on brand-capture spend.`,
  ];
}
