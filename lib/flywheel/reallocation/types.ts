// Marketr — Phase 7 F1: budget reallocation agent, shared types.
//
// Money is integer cents everywhere. Every proposal carries a full decision
// record (data window, curve params, R², model version) because "the
// algorithm decided" is not an audit answer.

export type CurveType = "hill" | "power" | "loglog";

export type ReallocationMode = "a" | "b"; // a = propose-only, b = SRA guardrails

export type ProposalStatus =
  | "proposed"
  | "policy_approved"
  | "policy_denied"
  | "human_approved"
  | "executed"
  | "rejected";

export type SraStatus = "active" | "revoked" | "expired";

export type BreakerType =
  | "performance"
  | "velocity"
  | "measurement"
  | "error_rate"
  | "attribution_regime";

/** One lagged spend→response observation (spend cents, attributed revenue cents). */
export interface DataPoint {
  ts: string; // ISO
  spendCents: number;
  revenueCents: number;
}

export interface AdstockParams {
  decay: number; // 0..1, carryover per period
}

export interface CurveParams {
  hill?: { ec50: number; slope: number; vmax: number };
  power?: { a: number; b: number };
  loglog?: { a: number; b: number };
}

export interface MarginalCurve {
  id: string;
  workspaceId: string;
  channel: string;
  curveType: CurveType;
  params: CurveParams;
  adstock: AdstockParams;
  seasonality: number[]; // 7 day-of-week multipliers, index 0 = Sunday
  rSquared: number;
  dataWindow: string; // e.g. "7d", "28d"
  /** Holdout-calibrated incrementality factor; multiplies platform-reported marginal. */
  iroasCalibrationFactor?: number;
  fittedAt: string; // ISO
  modelVersion: string;
}

/** The investigative payload attached to every proposal. */
export interface DecisionRecord {
  dataWindow: string;
  lagDays: number;
  curveParams: Record<string, MarginalCurve>;
  multiWindowAgreement: boolean;
  measurementHealth: "ok" | "degraded";
  marginalRoasSource: number;
  marginalRoasDest: number;
  marginalRoasDelta: number;
  /** When calibration exists: "platform 4.2x → holdout-calibrated 2.6x". */
  calibrationNote?: string;
  modelVersion: string;
  rationale: string;
}

export interface ReallocationProposal {
  id: string;
  workspaceId: string;
  mode: ReallocationMode;
  sraId: string | null;
  sourceChannel: string;
  destChannel: string;
  sourceCampaignRef: string;
  destCampaignRef: string;
  amountCents: number;
  marginalRoasDelta: number;
  decisionRecord: DecisionRecord;
  status: ProposalStatus;
  humanApprovalId: string | null;
  createdAt: string; // ISO
}

export interface PolicyDecision {
  id: string;
  proposalId: string;
  workspaceId: string;
  decision: "allow" | "deny";
  reasons: string[];
  sraId: string | null;
  revocationCheckedAt: string; // ISO
}

export interface SraEnvelope {
  id: string;
  workspaceId: string;
  name: string;
  channels: string[]; // explicit allowlist — campaigns eligible for moves
  perShiftCapCents: number;
  dailyAggregateCapCents: number;
  weeklyAggregateCapCents: number;
  perChannelBandPct: number; // ±% vs baseline budget
  explorationFloorPct: number;
  cooldownHours: number;
  validFrom: string; // ISO
  validUntil: string; // ISO — mandatory expiry, ≤30d from validFrom
  revocationId: string; // instant-revoke handle
  status: SraStatus;
  signerIds: string[]; // human signers; 2 required when cumulative ≥ $1k
  signatureHash: string;
  createdBy: string;
  createdAt: string; // ISO
  revokedAt: string | null; // ISO
  revokedBy: string | null;
}

export interface BreakerEvent {
  id: string;
  workspaceId: string;
  breakerType: BreakerType;
  /** Channel ref, or "global" for workspace-wide freezes. */
  scope: string;
  reason: string;
  firedAt: string; // ISO
  acknowledgedBy: string | null;
  acknowledgedAt: string | null; // ISO
  cooldownUntil: string; // ISO — mandatory ≥72h before the optimizer may touch scope again
}

export interface ReallocationRun {
  id: string;
  workspaceId: string;
  runAt: string; // ISO
  mode: ReallocationMode;
  proposalsCount: number;
  executedCount: number;
  deniedCount: number;
  frozen: boolean;
  dataHealthSnapshot: Record<string, unknown>;
}

export interface ChannelFloor {
  workspaceId: string;
  channel: string;
  /** Below ~10× target CPA/day campaigns can't exit learning — optimizing noise. */
  learningViableMinCentsDay: number;
  stabilizationHours: number;
}

export type AuditKind =
  | "proposal_created"
  | "proposal_status"
  | "policy_decision"
  | "sra_created"
  | "sra_revoked"
  | "sra_expired"
  | "execution"
  | "execution_halted"
  | "breaker_fired"
  | "breaker_acknowledged"
  | "run_completed"
  | "approval_materialized";

export interface AuditEvent {
  id: string;
  workspaceId: string;
  correlationId: string;
  kind: AuditKind;
  actor: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  prevHash: string;
  eventHash: string;
  ts: string; // ISO
}

/** Workspace-level optimizer tuning. */
export interface OptimizerTuning {
  minShiftPct: number; // default 0.05 — min meaningful shift vs channel budget
  maxStepPct: number; // default 0.20 — ≤20% of channel daily budget per step
  cooldownHours: number; // default 72
  explorationPct: number; // default 0.10 — slice the optimizer never touches
  lagDays: number; // default 3 — data-maturity delay; never optimize today's partials
  windowsDays: number[]; // default [7, 28] — multi-window agreement
  crossWindowStabilityRatio: number; // default 2.0 — a channel whose own marginal moves more than this across windows is unstable
  healthSigma: number; // default 2 — event-volume band
  crossSourceDisagreementPct: number; // default 0.15
}

export const DEFAULT_TUNING: OptimizerTuning = {
  minShiftPct: 0.05,
  maxStepPct: 0.2,
  cooldownHours: 72,
  explorationPct: 0.1,
  lagDays: 3,
  windowsDays: [7, 28],
  crossWindowStabilityRatio: 2.0,
  healthSigma: 2,
  crossSourceDisagreementPct: 0.15,
};
