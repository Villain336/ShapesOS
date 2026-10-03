// Marketr — Phase 5 S4: two-layer kill switch + client emergency stop.
//
// Layer 1 — Marketr sweeper (Birch-style rule engine):
//   { name, scope, condition, window, action (pause|reduce_budget|alert), cooldown }
//   Every action is logged to the approval's event log tracing back to the
//   human-set rule that fired.
// Layer 2 — platform-native rules provisioned as backup (Meta adrules_library,
//   Google Ads scripts) so protection survives a Marketr outage. Native rules
//   are the seatbelt; the sweeper is the airbag.
//
// The €7,937/day failure class (Apr 2026: a 25% hourly budget increase
// compounding to €7,937/day in 4 days — no persisted state, no account-level
// ceiling) is killed by the spend-anomaly + pool-exhausted rules below, the
// virtual-card limit (S2), and the platform spending limits (S3 pre-flight).

import { SafetyViolationError, type MediaRole } from "./safety";
import { ApprovalEventAction, ApprovalStore, MediaApproval, logApprovalEvent } from "./approvals";
import { BudgetPool, PoolStore, freezePool } from "./pools";

export type KillAction = "pause" | "reduce_budget" | "alert";
export type MetricName = "cpa" | "spend" | "daily_spend_pct" | "conversions" | "ctr" | "ctr_decay" | "failures";
export type Comparator = ">" | "<" | ">=" | "<=" | "==";

export interface KillRule {
  id: string;
  workspaceId: string;
  clientId: string | null;
  name: string;
  scope: { poolId?: string; platform?: string; buyId?: string; approvalId?: string };
  condition: {
    metric: MetricName;
    op: Comparator;
    value: number;
    /** Optional AND clause, e.g. spend > $100 for stop-loss. */
    and?: { metric: MetricName; op: Comparator; value: number };
  };
  window: string;
  action: KillAction;
  cooldownMinutes: number;
  enabled: boolean;
  createdBy: string;
  lastFiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KillRuleStore {
  create(r: Omit<KillRule, "id" | "createdAt" | "updatedAt" | "lastFiredAt">): Promise<KillRule>;
  get(id: string, workspaceId: string): Promise<KillRule | null>;
  list(workspaceId: string, enabledOnly?: boolean): Promise<KillRule[]>;
  setEnabled(id: string, workspaceId: string, enabled: boolean): Promise<KillRule>;
  markFired(id: string, workspaceId: string, at: Date): Promise<void>;
}

/** Default v1 rule pack — ships ENABLED (SPEC-PHASE5.md §9.8). */
export function defaultRulePack(workspaceId: string, clientId: string | null, createdBy: string): Array<Omit<KillRule, "id" | "createdAt" | "updatedAt" | "lastFiredAt">> {
  const base = { workspaceId, clientId, enabled: true, createdBy };
  return [
    {
      ...base,
      name: "stop-loss pause",
      scope: { },
      condition: { metric: "cpa", op: ">", value: 1.5, and: { metric: "spend", op: ">", value: 100 } },
      window: "1d",
      action: "pause",
      cooldownMinutes: 60,
    },
    {
      ...base,
      name: "test-cap kill",
      scope: {},
      condition: { metric: "spend", op: ">", value: 25, and: { metric: "conversions", op: "==", value: 0 } },
      window: "1d",
      action: "pause",
      cooldownMinutes: 60,
    },
    {
      ...base,
      name: "spend-anomaly alert",
      scope: {},
      // Daily spend > 80% of budget before noon — the early-warning tripwire
      // for the €7,937/day class: a compounding bug cannot run four days when
      // day one's morning spend pattern already fires an alert.
      condition: { metric: "daily_spend_pct", op: ">", value: 80 },
      window: "1d",
      action: "alert",
      cooldownMinutes: 120,
    },
    {
      ...base,
      name: "pool-exhausted pause-all",
      scope: {},
      condition: { metric: "daily_spend_pct", op: ">=", value: 100 },
      window: "15m",
      action: "pause",
      cooldownMinutes: 30,
    },
    {
      ...base,
      name: "creative-fatigue kill",
      scope: {},
      condition: { metric: "ctr_decay", op: ">", value: 30 },
      window: "7d",
      action: "pause",
      cooldownMinutes: 360,
    },
  ];
}

export interface MetricsSnapshot {
  poolId?: string;
  platform?: string;
  buyId?: string;
  approvalId?: string;
  cpa?: number;            // multiple of target CPA (1.5 = 1.5× target)
  spendCents: number;      // spend in the rule window
  dailySpendPct?: number;  // % of daily budget spent so far
  conversions: number;
  ctr?: number;
  ctrDecayPct?: number;    // CTR decay vs baseline, %
  failures?: number;       // consecutive execution failures
  hourOfDay?: number;      // local hour, for "before noon" conditions
  ts: Date;
}

export interface FiredAction {
  ruleId: string;
  ruleName: string;
  action: KillAction;
  snapshot: MetricsSnapshot;
  createdBy: string;
}

export interface SweeperDeps {
  now(): Date;
  /** Execute the action AND log it. Implementations must trace to the rule. */
  onAction(fired: FiredAction): Promise<void>;
}

function metricValue(m: MetricName, s: MetricsSnapshot): number | undefined {
  switch (m) {
    case "cpa": return s.cpa;
    case "spend": return s.spendCents / 100;
    case "daily_spend_pct": return s.dailySpendPct;
    case "conversions": return s.conversions;
    case "ctr": return s.ctr;
    case "ctr_decay": return s.ctrDecayPct;
    case "failures": return s.failures;
  }
}

function compare(op: Comparator, a: number, b: number): boolean {
  switch (op) {
    case ">": return a > b;
    case "<": return a < b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    case "==": return a === b;
  }
}

function scopeMatches(rule: KillRule, s: MetricsSnapshot): boolean {
  const sc = rule.scope;
  if (sc.poolId && sc.poolId !== s.poolId) return false;
  if (sc.platform && sc.platform.toLowerCase() !== s.platform?.toLowerCase()) return false;
  if (sc.buyId && sc.buyId !== s.buyId) return false;
  if (sc.approvalId && sc.approvalId !== s.approvalId) return false;
  return true;
}

function conditionHolds(rule: KillRule, s: MetricsSnapshot): boolean {
  const c = rule.condition;
  const v = metricValue(c.metric, s);
  if (v === undefined) return false;
  if (!compare(c.op, v, c.value)) return false;
  if (c.and) {
    const v2 = metricValue(c.and.metric, s);
    if (v2 === undefined || !compare(c.and.op, v2, c.and.value)) return false;
  }
  // "before noon" guard for the spend-anomaly rule when hour is provided.
  if (rule.name === "spend-anomaly alert" && s.hourOfDay !== undefined && s.hourOfDay >= 12) return false;
  return true;
}

function cooldownActive(rule: KillRule, now: Date): boolean {
  if (!rule.lastFiredAt) return false;
  return now.getTime() - rule.lastFiredAt.getTime() < rule.cooldownMinutes * 60 * 1000;
}

export async function evaluateRules(
  store: KillRuleStore,
  workspaceId: string,
  snapshots: MetricsSnapshot[],
  deps: SweeperDeps,
): Promise<FiredAction[]> {
  const now = deps.now();
  const fired: FiredAction[] = [];
  const rules = await store.list(workspaceId, true).catch(() => [] as KillRule[]);
  for (const snapshot of snapshots) {
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (cooldownActive(rule, now)) continue;
      if (!scopeMatches(rule, snapshot)) continue;
      if (!conditionHolds(rule, snapshot)) continue;
      const action: FiredAction = {
        ruleId: rule.id, ruleName: rule.name, action: rule.action,
        snapshot, createdBy: rule.createdBy,
      };
      await deps.onAction(action);
      await store.markFired(rule.id, rule.workspaceId, now);
      fired.push(action);
    }
  }
  return fired;
}

// ---------------------------------------------------------------------------
// Circuit breaker: 3 failed executions → freeze the channel.
// ---------------------------------------------------------------------------

export class ExecutionCircuitBreaker {
  private failures = new Map<string, number>();
  constructor(private readonly threshold = 3) {}

  recordFailure(channelKey: string): { frozen: boolean; count: number } {
    const count = (this.failures.get(channelKey) ?? 0) + 1;
    this.failures.set(channelKey, count);
    return { frozen: count >= this.threshold, count };
  }

  recordSuccess(channelKey: string): void {
    this.failures.delete(channelKey);
  }

  isFrozen(channelKey: string): boolean {
    return (this.failures.get(channelKey) ?? 0) >= this.threshold;
  }
}

// ---------------------------------------------------------------------------
// Platform-native rules as backup (provisioned at campaign creation).
// Stubs: payloads to provision; the B-tracks wire the actual API calls.
// ---------------------------------------------------------------------------

export interface NativeRulePayload {
  platform: "meta" | "google";
  description: string;
  /** Ready-to-send payload / script for the platform API. */
  payload: unknown;
}

export function provisionNativeRulesStub(opts: {
  platform: string;
  campaignName: string;
  maxDailySpendCents: number;
  targetCpaCents?: number;
}): NativeRulePayload[] {
  const p = opts.platform.toLowerCase();
  if (p === "meta") {
    return [
      {
        platform: "meta",
        description: "Meta automated rule (adrules_library): pause ad set when CPA > 1.5× target and spend > $100 — seatbelt backup for the ShapesOS sweeper stop-loss.",
        payload: {
          evaluation: "adrules_library",
          name: `[marketr] stop-loss ${opts.campaignName}`,
          condition: {
            cpa_multiple: 1.5,
            spend_cents_gt: 10000,
          },
          action: "pause",
        },
      },
      {
        platform: "meta",
        description: "Meta account spending limit set at pool cap — the hard ceiling the €7,937/day class lacked.",
        payload: { account_spending_limit_cents: opts.maxDailySpendCents * 30 },
      },
    ];
  }
  if (p === "google") {
    return [
      {
        platform: "google",
        description: "Google Ads automated rule / script: pause campaign on stop-loss; daily budget cap. NOTE: Google has no true account-level monthly cap — the virtual-card limit + ShapesOS sweeper are the ceiling.",
        payload: {
          script: "// [marketr] stop-loss: pause campaign if cost > 1.5× target CPA with spend > $100\n// Deploy as an hourly Google Ads script on the client's account.",
          campaign_name: opts.campaignName,
        },
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Client-level emergency stop
// ---------------------------------------------------------------------------

export interface EmergencyStopInput {
  workspaceId: string;
  clientId: string;
  reason: string;
  actor: string;
  actorMediaRole: MediaRole;
}

export interface EmergencyStopDeps {
  poolStore: PoolStore;
  approvalStore: ApprovalStore;
  /** Pause every active entity for the client (platform hooks; B-tracks). */
  pauseAllClientEntities(workspaceId: string, clientId: string): Promise<{ paused: number }>;
  now(): Date;
}

export interface EmergencyStopResult {
  poolsFrozen: string[];
  approvalsRevoked: string[];
  entitiesPaused: number;
  auditTrail: Record<string, unknown>;
}

export async function emergencyStop(
  input: EmergencyStopInput,
  deps: EmergencyStopDeps,
): Promise<EmergencyStopResult> {
  if (input.actorMediaRole !== "owner") {
    throw new SafetyViolationError("Emergency stop requires the media owner role.");
  }
  if (!input.reason || input.reason.trim().length < 8) {
    throw new SafetyViolationError("Emergency stop requires a written reason (min 8 chars).");
  }
  const { workspaceId, clientId, actor } = input;
  const ts = deps.now();

  // 1. Pause every active entity across all platforms.
  const { paused } = await deps.pauseAllClientEntities(workspaceId, clientId);

  // 2. Revoke pending approvals (releases encumbrances via the route wiring).
  const pending = await deps.approvalStore.listPendingForClient(workspaceId, clientId);
  const approvalsRevoked: string[] = [];
  for (const a of pending) {
    await deps.approvalStore.update(a.id, workspaceId, { status: "revoked", revokedAt: ts, revokedBy: actor });
    await logApprovalEvent(deps.approvalStore, a.id, workspaceId, actor, "emergency_stop", {
      reason: input.reason,
    });
    approvalsRevoked.push(a.id);
  }

  // 3. Freeze all pools for the client.
  const pools = await deps.poolStore.list(workspaceId, clientId);
  const poolsFrozen: string[] = [];
  for (const p of pools) {
    if (p.status === "active") {
      await freezePool(deps.poolStore, p.id, workspaceId, actor, `emergency stop: ${input.reason}`);
      poolsFrozen.push(p.id);
    }
  }

  // 4. Export the audit trail (immutable record of the stop).
  const auditTrail = await exportAuditTrail(deps.approvalStore, deps.poolStore, workspaceId, clientId);

  return { poolsFrozen, approvalsRevoked, entitiesPaused: paused, auditTrail };
}

export async function exportAuditTrail(
  approvalStore: ApprovalStore,
  poolStore: PoolStore,
  workspaceId: string,
  clientId?: string,
): Promise<Record<string, unknown>> {
  const approvals = await approvalStore.list(workspaceId, undefined, 1000);
  const scoped = clientId ? approvals.filter((a) => a.clientId === clientId) : approvals;
  const events: Record<string, unknown[]> = {};
  for (const a of scoped) {
    events[a.id] = await approvalStore.getEvents(a.id, workspaceId, 1000);
  }
  const pools = await poolStore.list(workspaceId, clientId);
  const txs: Record<string, unknown[]> = {};
  for (const p of pools) {
    txs[p.id] = await poolStore.listTxs(p.id, workspaceId, 1000);
  }
  return {
    exportedAt: new Date().toISOString(),
    workspaceId,
    clientId: clientId ?? null,
    approvals: scoped.map((a) => ({
      id: a.id, type: a.type, status: a.status, bindingHash: a.bindingHash,
      maxSpendCents: a.maxSpendCents, approvers: a.approvers, createdBy: a.createdBy,
    })),
    events,
    pools: pools.map((p) => ({ ...p })),
    poolTransactions: txs,
  };
}

// ---------------------------------------------------------------------------
// In-memory kill-rule store (tests / verify battery)
// ---------------------------------------------------------------------------

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export function createMemoryKillRuleStore(workspaceId: string): KillRuleStore {
  const rules = new Map<string, KillRule>();
  return {
    async create(r) {
      const now = new Date();
      const row: KillRule = { ...structuredClone(r), id: uid("kr"), createdAt: now, updatedAt: now, lastFiredAt: null };
      rules.set(`${row.workspaceId}:${row.id}`, row);
      return structuredClone(row);
    },
    async get(id, ws) {
      const r = rules.get(`${ws}:${id}`);
      return r ? structuredClone(r) : null;
    },
    async list(ws) {
      return [...rules.values()].filter((r) => !ws || r.workspaceId === ws).map((e) => structuredClone(e));
    },
    async setEnabled(id, ws, enabled) {
      const r = rules.get(`${ws}:${id}`);
      if (!r) throw new SafetyViolationError("Kill rule not found in workspace.");
      r.enabled = enabled;
      r.updatedAt = new Date();
      return structuredClone(r);
    },
    async markFired(id, ws, at) {
      const r = rules.get(`${ws}:${id}`);
      if (r) { r.lastFiredAt = at; r.updatedAt = new Date(); }
    },
  };
}

export function seedDefaultRulePack(store: KillRuleStore, workspaceId: string, clientId: string | null, createdBy: string) {
  return Promise.all(defaultRulePack(workspaceId, clientId, createdBy).map((r) => store.create(r)));
}

export type { MediaApproval };
export { logApprovalEvent as logMediaEvent };
export type { ApprovalEventAction };
