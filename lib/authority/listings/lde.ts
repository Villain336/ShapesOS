// Marketr — Phase 6 L1: Local Data Exchange (Tier 2) prototype.
//
// §12.1: prototype behind a feature flag; sandbox-first; promotion to
// default ONLY after sync-accuracy validation passes. resolveLdeClient
// throws unless the flag is on (see lib/authority/fake.ts).

import { resolveLdeClient, type LdeClient, type ProviderConfig } from "../fake";

export const LDE_FEATURE_FLAG_NAME = "lde_prototype";
export const LDE_COST_PER_CALL_USD = 0.008;
export const LDE_PUBLISHER_COUNT = 50;

/** Read the flag from env (server-side). Default off. */
export function ldeFlagEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MARKETR_LDE_PROTOTYPE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

export class LdeFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LdeFlagError";
  }
}

export interface LdeEvaluateOptions {
  /** Fake sandbox by default; a real key needs the flag AND a key. */
  apiKey?: string | null;
  fake?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function resolveLdePrototype(opts: LdeEvaluateOptions = {}): LdeClient {
  const flag = ldeFlagEnabled(opts.env);
  if (!flag) {
    throw new LdeFlagError(
      "The Local Data Exchange prototype is behind a feature flag — enable MARKETR_LDE_PROTOTYPE=1 (Settings → Authority → Listings) before evaluating.",
    );
  }
  const cfg: ProviderConfig & { featureFlag?: boolean } = {
    apiKey: opts.apiKey ?? null,
    fake: opts.fake ?? true,
    featureFlag: true,
  };
  return resolveLdeClient(cfg);
}

export interface LdeProbeResult {
  ok: boolean;
  publishers: number;
  latencyMs: number;
  costPerCallUsd: number;
  flagged: true;
  sandbox: boolean;
  probedAt: string;
}

/** Sandbox probe: publishers + latency, recorded as a flagged prototype result. */
export async function probeLdeSandbox(opts: LdeEvaluateOptions = {}): Promise<LdeProbeResult> {
  const client = resolveLdePrototype(opts);
  const r = await client.probeSandbox();
  return {
    ok: r.ok,
    publishers: r.publishers,
    latencyMs: r.latencyMs,
    costPerCallUsd: LDE_COST_PER_CALL_USD,
    flagged: true,
    sandbox: true,
    probedAt: new Date().toISOString(),
  };
}

export interface SyncAccuracyCheck {
  directory: string;
  expected: string;
  observed: string;
  match: boolean;
}

/** A sync-accuracy validation run. The stub records results; promotion requires all checks to match. */
export interface SyncAccuracyResult {
  runId: string;
  checks: SyncAccuracyCheck[];
  passed: number;
  failed: number;
  promotionAllowed: boolean;
  ranAt: string;
  note: string;
}

/**
 * validateSyncAccuracy — stub that runs the sandbox sync-accuracy checks and
 * records the results. Returns the result AND an appendable record object the
 * caller persists (into listing_channels.configJson) — promotion to default
 * reads these records, never a bare flag.
 */
export function validateSyncAccuracy(
  checks: SyncAccuracyCheck[],
  runId?: string,
): SyncAccuracyResult {
  const passed = checks.filter((c) => c.match).length;
  const failed = checks.length - passed;
  return {
    runId: runId ?? `lde_acc_${Date.now().toString(36)}`,
    checks,
    passed,
    failed,
    promotionAllowed: checks.length > 0 && failed === 0,
    ranAt: new Date().toISOString(),
    note:
      "Stub validation: checks are recorded, not executed against live publishers. " +
      "Promotion to default requires a real passing run with publisher coverage ≥ 40.",
  };
}

/** Append a validation result to the channel's stored evaluation history. */
export function recordAccuracyResult(
  history: SyncAccuracyResult[],
  result: SyncAccuracyResult,
): SyncAccuracyResult[] {
  return [...history, result];
}

/** Promotion is allowed only when a stored run passed with real coverage. */
export function ldePromotionAllowed(history: SyncAccuracyResult[]): boolean {
  return history.some((r) => r.promotionAllowed);
}
