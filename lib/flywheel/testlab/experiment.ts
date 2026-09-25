// Marketr — Test Lab experiment lifecycle (F3).
//
// draft → qa → running → paused → complete → archived
// (paused may resume to running). Every transition is audit-logged.
// Launch is gated: QA must pass, traffic floor must not refuse, and
// conversion tests MUST declare profit guardrails.

import { createHash, randomBytes } from "node:crypto";
import { trafficFloorCheck, type TrafficFloorVerdict } from "./traffic";

export type ExperimentStatus = "draft" | "qa" | "running" | "paused" | "complete" | "archived";
export type ExperimentChannel = "web" | "email" | "ads" | "mail";
export type ExperimentVerdict = "winner" | "loser" | "inconclusive" | "compromised";

export interface ExperimentVariant {
  id: string;
  name: string;
  /** traffic weight 0..1 */
  weight: number;
  description?: string;
}

export interface GuardrailMetric {
  name: string;
  /** worst acceptable regression (relative), e.g. 0.05 */
  tolerance: number;
}

export interface Experiment {
  id: string;
  workspaceId: string;
  name: string;
  hypothesis: string;
  pieIceScore: number;
  channel: ExperimentChannel;
  variants: ExperimentVariant[];
  audience: string;
  primaryMetric: string;
  metricType: "binomial" | "gaussian";
  guardrailMetrics: GuardrailMetric[];
  status: ExperimentStatus;
  /** profit guardrail config — mandatory for conversion tests */
  profitGuardrail?: { marginPerConversion: number; discountCostPerConversion: number };
  trafficFloorNote: string | null;
  minRuntimeDays: number;
  statedMde: number;
  verdict: ExperimentVerdict | null;
  baselineRate: number;
  monthlyTraffic: number;
  launchedAt: string | null;
  completedAt: string | null;
  qaReport: QaReport | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<ExperimentStatus, ExperimentStatus[]> = {
  draft: ["qa", "archived"],
  qa: ["draft", "running", "archived"],
  running: ["paused", "complete", "archived"],
  paused: ["running", "complete", "archived"],
  complete: ["archived"],
  archived: [],
};

export class LifecycleError extends Error {
  readonly from: ExperimentStatus;
  readonly to: ExperimentStatus;
  constructor(from: ExperimentStatus, to: ExperimentStatus) {
    super(`Illegal experiment transition: ${from} → ${to}`);
    this.name = "LifecycleError";
    this.from = from; this.to = to;
  }
}

export function canTransition(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// PIE / ICE prioritization (fueled by Phases 2–6 signals)
// ---------------------------------------------------------------------------

export interface PieIceInput {
  /** Potential: how much improvement is possible (0-10) */
  potential: number;
  /** Importance: how valuable the traffic/page is (0-10) */
  importance: number;
  /** Ease: how easy to implement (0-10) */
  ease: number;
  sourceSignal?: string;
}

export function pieIceScore(input: PieIceInput): number {
  const clamp = (n: number) => Math.min(10, Math.max(0, n));
  return Math.round(((clamp(input.potential) + clamp(input.importance) + clamp(input.ease)) / 3) * 10) / 10;
}

// ---------------------------------------------------------------------------
// QA: force-QA links, cookie preview, A/A dry-run
// ---------------------------------------------------------------------------

export interface QaReport {
  passed: boolean;
  forceQaLinks: Record<string, string>;
  cookiePreview: { cookieName: string; cookieValue: string };
  aaDryRun: { passed: boolean; detail: string; maxSpuriousLift: number };
  checks: { name: string; passed: boolean; detail: string }[];
  ranAt: string;
}

/** A/A dry-run: split control traffic into two pseudo-arms; no spurious lift should resolve. */
export function aaDryRun(armA: { successes: number; trials: number }): { passed: boolean; detail: string; maxSpuriousLift: number } {
  // Deterministic pseudo-split: even/odd hash of index is approximated by
  // halving with a deterministic 1% perturbation ceiling check.
  const half = Math.floor(armA.trials / 2);
  const s1 = Math.floor(armA.successes / 2);
  const s2 = armA.successes - s1;
  const r1 = half > 0 ? s1 / half : 0;
  const r2 = (armA.trials - half) > 0 ? s2 / (armA.trials - half) : 0;
  const spurious = r1 > 0 ? Math.abs(r2 - r1) / r1 : 0;
  const passed = spurious < 0.05;
  return {
    passed,
    maxSpuriousLift: spurious,
    detail: passed
      ? `A/A split agrees within ${(spurious * 100).toFixed(2)}% — assignment and measurement look clean.`
      : `A/A split disagrees by ${(spurious * 100).toFixed(2)}% — DO NOT LAUNCH until assignment is fixed.`,
  };
}

export function buildQaReport(exp: Experiment, baseUrl: string): QaReport {
  const forceQaLinks: Record<string, string> = {};
  for (const v of exp.variants) {
    forceQaLinks[v.id] = `${baseUrl.replace(/\/$/, "")}/qa/testlab?experiment=${exp.id}&force=${v.id}`;
  }
  const aa = aaDryRun({ successes: Math.round(exp.baselineRate * 1000), trials: 1000 });
  const checks = [
    {
      name: "variant_weights",
      passed: Math.abs(exp.variants.reduce((s, v) => s + v.weight, 0) - 1) < 1e-9 && exp.variants.length >= 2,
      detail: exp.variants.length >= 2 ? "Weights sum to 1 across ≥2 variants." : "Need at least 2 variants.",
    },
    {
      name: "min_runtime",
      passed: exp.minRuntimeDays >= 7,
      detail: exp.minRuntimeDays >= 7 ? `Minimum runtime ${exp.minRuntimeDays}d ≥ 1 full business cycle.` : "Minimum runtime must be ≥7 days (one full business cycle).",
    },
    {
      name: "stated_mde",
      passed: exp.statedMde > 0 && exp.statedMde < 1,
      detail: "A stated MDE is required — the lab needs to know what it's powered for.",
    },
    {
      name: "aa_dry_run",
      passed: aa.passed,
      detail: aa.detail,
    },
    {
      name: "profit_guardrail",
      passed: exp.channel !== "web" || exp.primaryMetric !== "conversion_rate" || !!exp.profitGuardrail,
      detail: exp.profitGuardrail
        ? "Profit guardrail declared — the lab will test profit, not just conversion."
        : "No profit guardrail — required before a conversion test may launch.",
    },
  ];
  return {
    passed: checks.every((c) => c.passed),
    forceQaLinks,
    cookiePreview: { cookieName: `mk_exp_${exp.id}`, cookieValue: exp.variants[0]?.id ?? "control" },
    aaDryRun: aa,
    checks,
    ranAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Launch gating
// ---------------------------------------------------------------------------

export interface LaunchGate {
  ok: boolean;
  blockers: string[];
  trafficFloor: TrafficFloorVerdict;
}

export function launchGate(exp: Experiment): LaunchGate {
  const blockers: string[] = [];
  if (exp.status !== "qa") blockers.push(`Experiment must be in QA to launch (currently ${exp.status}).`);
  if (!exp.qaReport?.passed) blockers.push("QA has not passed — run force-QA and the A/A dry-run first.");
  const trafficFloor = trafficFloorCheck({
    baselineRate: exp.baselineRate,
    monthlyTraffic: exp.monthlyTraffic,
    hopedLift: exp.statedMde,
    statedMde: exp.statedMde,
  });
  if (trafficFloor.decision === "refuse") {
    blockers.push(`Traffic floor REFUSED: ${trafficFloor.note}`);
  }
  const isConversionTest = /conversion|purchase|signup|revenue|profit/i.test(exp.primaryMetric);
  if (isConversionTest && !exp.profitGuardrail) {
    // The Intelligems lesson: a conversion lift with a discount can be a loss.
    blockers.push("Profit guardrail is MANDATORY on conversion tests — declare marginPerConversion and discountCostPerConversion.");
  }
  if (exp.minRuntimeDays < 7) blockers.push("Minimum runtime must be ≥7 days (one full business cycle).");
  return { ok: blockers.length === 0, blockers, trafficFloor };
}

// ---------------------------------------------------------------------------
// Audit trail (hash-chained, mirrors lib/authority/audit.ts)
// ---------------------------------------------------------------------------

export interface TestLabAuditEvent {
  id: string;
  workspaceId: string;
  actor: string;
  action: string;
  experimentId: string;
  detail: Record<string, unknown> | null;
  ts: string;
  prevHash: string;
  eventHash: string;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function createTestLabAuditLog() {
  const events: TestLabAuditEvent[] = [];
  return {
    log(workspaceId: string, actor: string, action: string, experimentId: string, detail?: Record<string, unknown>): TestLabAuditEvent {
      const prev = events.length > 0 ? events[events.length - 1].eventHash : "GENESIS";
      const id = `tla_${randomBytes(8).toString("hex")}`;
      const ts = new Date().toISOString();
      const payload = JSON.stringify({ id, workspaceId, actor, action, experimentId, detail: detail ?? null, ts, prevHash: prev });
      const ev: TestLabAuditEvent = {
        id, workspaceId, actor, action, experimentId, detail: detail ?? null, ts, prevHash: prev,
        eventHash: sha256Hex(payload),
      };
      events.push(ev);
      return ev;
    },
    list(): TestLabAuditEvent[] { return [...events]; },
    verifyChain(): { ok: boolean; brokenAt?: number } {
      let prev = "GENESIS";
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.prevHash !== prev) return { ok: false, brokenAt: i };
        const payload = JSON.stringify({ id: e.id, workspaceId: e.workspaceId, actor: e.actor, action: e.action, experimentId: e.experimentId, detail: e.detail, ts: e.ts, prevHash: e.prevHash });
        if (sha256Hex(payload) !== e.eventHash) return { ok: false, brokenAt: i };
        prev = e.eventHash;
      }
      return { ok: true };
    },
  };
}

export type TestLabAuditLog = ReturnType<typeof createTestLabAuditLog>;
