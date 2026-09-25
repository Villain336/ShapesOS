// Marketr — Phase 5 S2: non-custodial budget pools.
//
// The "media wallet" as accounting, not custody. A BudgetPool is a cap with
// a ledger — the money itself NEVER passes through Marketr. Spend flows from
// the client's own accounts/cards; the pool tracks caps, encumbrances, and
// refs to the client's own instruments (virtual_card_ref only — never PANs).
//
// ZERO custody is structural: there is no balance-holding, no fronting, no
// co-mingling anywhere in this module. Over-encumbrance is rejected by the
// service layer (and by the SQL store's conditional UPDATE, so concurrent
// approvals cannot double-count — the €7,937/day failure class dies here).

import { SafetyViolationError } from "./safety";

export type PoolPeriod = "monthly" | "campaign" | "one_time";
export type PoolStatus = "active" | "frozen" | "exhausted";
export type PoolTxKind = "encumber" | "spend" | "release" | "adjust";

export interface BudgetPool {
  id: string;
  workspaceId: string;
  clientId: string;
  name: string;
  period: PoolPeriod;
  capCents: number;
  remainingCents: number;
  encumberedCents: number;
  currency: string;
  platformAllowlist: string[];
  autoApproveThresholdCents: number;
  alertThresholds: number[];
  virtualCardRef: string | null;
  cardProvider: "brex" | "ramp" | "fake";
  status: PoolStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PoolTransaction {
  id: string;
  poolId: string;
  workspaceId: string;
  approvalId: string | null;
  kind: PoolTxKind;
  amountCents: number;
  runningRemainingCents: number;
  runningEncumberedCents: number;
  actor: string;
  ts: Date;
  note: string | null;
}

export interface PoolStore {
  get(poolId: string, workspaceId: string): Promise<BudgetPool | null>;
  create(input: Omit<BudgetPool, "id" | "createdAt" | "updatedAt">): Promise<BudgetPool>;
  /**
   * Atomic conditional encumber. Returns the updated pool, or null when the
   * pool cannot cover the amount (insufficient remaining, wrong status, or a
   * concurrent approval won the race). Implementations MUST apply the
   * predicate atomically — see SqlPoolStore's conditional UPDATE.
   */
  tryEncumber(poolId: string, workspaceId: string, amountCents: number): Promise<BudgetPool | null>;
  release(poolId: string, workspaceId: string, amountCents: number): Promise<BudgetPool>;
  convertToSpend(poolId: string, workspaceId: string, amountCents: number): Promise<BudgetPool>;
  freeze(poolId: string, workspaceId: string, actor: string): Promise<BudgetPool>;
  unfreeze(poolId: string, workspaceId: string, actor: string): Promise<BudgetPool>;
  attachVirtualCard(poolId: string, workspaceId: string, cardRef: string, provider: BudgetPool["cardProvider"]): Promise<BudgetPool>;
  recordTx(tx: Omit<PoolTransaction, "id" | "ts"> & { ts?: Date }): Promise<PoolTransaction>;
  listTxs(poolId: string, workspaceId: string, limit?: number): Promise<PoolTransaction[]>;
  list(workspaceId: string, clientId?: string): Promise<BudgetPool[]>;
  /**
   * Cents currently reserved for a specific approval (encumber − release − spend).
   * The executor's pre-flight MUST use this, not pool.remainingCents: approval
   * already moved maxTotalSpendCents out of `remaining` into `encumbered`, so a
   * remaining-based check would double-count and falsely HALT fully-encumbered
   * (i.e. fully-funded) buys. Fail closed: missing rows → 0.
   */
  reservedForApproval(poolId: string, workspaceId: string, approvalId: string): Promise<number>;
}

/** Utilization = (cap - remaining) / cap. Drives the 50/75/90% alerts. */
export function poolUtilization(pool: BudgetPool): number {
  if (pool.capCents <= 0) return 1;
  return (pool.capCents - pool.remainingCents) / pool.capCents;
}

export class PoolViolationError extends SafetyViolationError {
  constructor(message: string) {
    super(message);
    this.name = "PoolViolationError";
  }
}

export interface EncumberResult {
  pool: BudgetPool;
  /** Alert thresholds newly crossed by this encumbrance (e.g. [75, 90]). */
  alertsFired: number[];
}

export interface CreatePoolInput {
  workspaceId: string;
  clientId: string;
  name: string;
  period: PoolPeriod;
  capCents: number;
  currency?: string;
  platformAllowlist: string[];
  autoApproveThresholdCents?: number; // default 0 = disabled (Tico, 2026-09-25)
  alertThresholds?: number[];
  createdBy: string;
}

export async function createPool(store: PoolStore, input: CreatePoolInput): Promise<BudgetPool> {
  if (!Number.isInteger(input.capCents) || input.capCents <= 0) {
    throw new PoolViolationError("Pool cap must be a positive integer number of cents.");
  }
  if (input.platformAllowlist.length === 0) {
    throw new PoolViolationError("Pool requires a non-empty platform allowlist (Brex vendor-lock pattern).");
  }
  return store.create({
    workspaceId: input.workspaceId,
    clientId: input.clientId,
    name: input.name.trim().slice(0, 160),
    period: input.period,
    capCents: input.capCents,
    remainingCents: input.capCents,
    encumberedCents: 0,
    currency: (input.currency ?? "USD").toUpperCase(),
    platformAllowlist: [...new Set(input.platformAllowlist.map((p) => p.trim().toLowerCase()))],
    autoApproveThresholdCents: input.autoApproveThresholdCents ?? 0,
    alertThresholds: input.alertThresholds ?? [50, 75, 90],
    virtualCardRef: null,
    cardProvider: "fake",
    status: "active",
    createdBy: input.createdBy,
  });
}

function crossedThresholds(before: number, after: number, thresholds: number[]): number[] {
  return thresholds.filter((t) => before < t / 100 && after >= t / 100);
}

/**
 * Encumber max_total_spend against the pool at approval time (S2 lifecycle).
 * Rejects when: pool missing/inactive, platform not allowlisted, or the
 * atomic tryEncumber fails (over-encumbrance — incl. the concurrent race).
 */
export async function encumberForApproval(
  store: PoolStore,
  opts: {
    poolId: string;
    workspaceId: string;
    approvalId: string;
    amountCents: number;
    platform: string;
    actor: string;
  },
): Promise<EncumberResult> {
  const { poolId, workspaceId, approvalId, amountCents, platform, actor } = opts;
  const before = await store.get(poolId, workspaceId);
  if (!before) throw new PoolViolationError("Budget pool not found in workspace.");
  if (before.status !== "active") {
    throw new PoolViolationError(`Pool is ${before.status} — encumbrance rejected.`);
  }
  if (!before.platformAllowlist.includes(platform.trim().toLowerCase())) {
    throw new PoolViolationError(`Platform "${platform}" is not allowlisted on this pool.`);
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new PoolViolationError("Encumbrance amount must be a positive integer.");
  }
  const beforeUtil = poolUtilization(before);
  // Atomic: the store applies remaining_cents >= amount in the same UPDATE,
  // so two concurrent approvals can never double-count the same cents.
  const after = await store.tryEncumber(poolId, workspaceId, amountCents);
  if (!after) {
    throw new PoolViolationError(
      `Over-encumbrance rejected: pool remaining ${before.remainingCents}c < requested ${amountCents}c ` +
        `(or pool changed status concurrently). This is the €7,937/day guardrail — ` +
        `a pool can never encumber beyond its remaining cap.`,
    );
  }
  await store.recordTx({
    poolId,
    workspaceId,
    approvalId,
    kind: "encumber",
    amountCents,
    runningRemainingCents: after.remainingCents,
    runningEncumberedCents: after.encumberedCents,
    actor,
    note: `Encumbered for approval ${approvalId}`,
  });
  const alertsFired = crossedThresholds(beforeUtil, poolUtilization(after), after.alertThresholds);
  return { pool: after, alertsFired };
}

/** Expiry / revocation releases the encumbrance back to remaining. */
export async function releaseEncumbrance(
  store: PoolStore,
  opts: { poolId: string; workspaceId: string; approvalId: string; amountCents: number; actor: string; reason: string },
): Promise<BudgetPool> {
  const { poolId, workspaceId, approvalId, amountCents, actor, reason } = opts;
  const pool = await store.release(poolId, workspaceId, amountCents);
  await store.recordTx({
    poolId, workspaceId, approvalId, kind: "release", amountCents,
    runningRemainingCents: pool.remainingCents,
    runningEncumberedCents: pool.encumberedCents,
    actor, note: reason,
  });
  return pool;
}

/** Execution converts encumbrance → actual spend (reconciled later by A1). */
export async function convertEncumbranceToSpend(
  store: PoolStore,
  opts: { poolId: string; workspaceId: string; approvalId: string; amountCents: number; actor: string },
): Promise<BudgetPool> {
  const { poolId, workspaceId, approvalId, amountCents, actor } = opts;
  const pool = await store.convertToSpend(poolId, workspaceId, amountCents);
  await store.recordTx({
    poolId, workspaceId, approvalId, kind: "spend", amountCents,
    runningRemainingCents: pool.remainingCents,
    runningEncumberedCents: pool.encumberedCents,
    actor, note: `Execution spend for approval ${approvalId}`,
  });
  return pool;
}

/** Freeze: blocks new encumbrance; existing encumbrances stay until released. */
export async function freezePool(
  store: PoolStore,
  poolId: string,
  workspaceId: string,
  actor: string,
  reason: string,
): Promise<BudgetPool> {
  const pool = await store.freeze(poolId, workspaceId, actor);
  await store.recordTx({
    poolId, workspaceId, approvalId: null, kind: "adjust", amountCents: 0,
    runningRemainingCents: pool.remainingCents,
    runningEncumberedCents: pool.encumberedCents,
    actor, note: `Pool frozen: ${reason}`,
  });
  return pool;
}

// ---------------------------------------------------------------------------
// In-memory store (tests / verify battery). The SQL store in lib/media/db.ts
// is the production implementation; both obey the same atomicity contract.
// ---------------------------------------------------------------------------

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export function createMemoryPoolStore(): PoolStore {
  const pools = new Map<string, BudgetPool>();
  const txs: PoolTransaction[] = [];
  const key = (poolId: string, workspaceId: string) => `${workspaceId}:${poolId}`;

  return {
    async get(poolId, workspaceId) {
      const p = pools.get(key(poolId, workspaceId));
      return p ? { ...p, platformAllowlist: [...p.platformAllowlist] } : null;
    },
    async create(input) {
      const now = new Date();
      const pool: BudgetPool = { ...input, id: uid("pool"), createdAt: now, updatedAt: now };
      pools.set(key(pool.id, pool.workspaceId), pool);
      return { ...pool };
    },
    async tryEncumber(poolId, workspaceId, amountCents) {
      // Single-threaded JS executes this synchronously to the write, which
      // models the SQL conditional UPDATE: the predicate
      // (status=active AND remaining >= amount) is evaluated atomically
      // with the mutation — no interleaving can slip between check and set.
      const k = key(poolId, workspaceId);
      const p = pools.get(k);
      if (!p || p.status !== "active" || p.remainingCents < amountCents) return null;
      const next: BudgetPool = {
        ...p,
        remainingCents: p.remainingCents - amountCents,
        encumberedCents: p.encumberedCents + amountCents,
        status: p.remainingCents - amountCents <= 0 ? "exhausted" : p.status,
        updatedAt: new Date(),
      };
      pools.set(k, next);
      return { ...next };
    },
    async release(poolId, workspaceId, amountCents) {
      const k = key(poolId, workspaceId);
      const p = pools.get(k);
      if (!p) throw new PoolViolationError("Budget pool not found in workspace.");
      const released = Math.min(amountCents, p.encumberedCents);
      const next: BudgetPool = {
        ...p,
        remainingCents: p.remainingCents + released,
        encumberedCents: p.encumberedCents - released,
        status: p.status === "exhausted" && p.remainingCents + released > 0 ? "active" : p.status,
        updatedAt: new Date(),
      };
      pools.set(k, next);
      return { ...next };
    },
    async convertToSpend(poolId, workspaceId, amountCents) {
      const k = key(poolId, workspaceId);
      const p = pools.get(k);
      if (!p) throw new PoolViolationError("Budget pool not found in workspace.");
      const spent = Math.min(amountCents, p.encumberedCents);
      const next: BudgetPool = {
        ...p,
        encumberedCents: p.encumberedCents - spent,
        updatedAt: new Date(),
      };
      pools.set(k, next);
      return { ...next };
    },
    async freeze(poolId, workspaceId) {
      const k = key(poolId, workspaceId);
      const p = pools.get(k);
      if (!p) throw new PoolViolationError("Budget pool not found in workspace.");
      const next = { ...p, status: "frozen" as PoolStatus, updatedAt: new Date() };
      pools.set(k, next);
      return { ...next };
    },
    async unfreeze(poolId, workspaceId) {
      const k = key(poolId, workspaceId);
      const p = pools.get(k);
      if (!p) throw new PoolViolationError("Budget pool not found in workspace.");
      const next = {
        ...p,
        status: (p.remainingCents <= 0 ? "exhausted" : "active") as PoolStatus,
        updatedAt: new Date(),
      };
      pools.set(k, next);
      return { ...next };
    },
    async attachVirtualCard(poolId, workspaceId, cardRef, provider) {
      const k = key(poolId, workspaceId);
      const p = pools.get(k);
      if (!p) throw new PoolViolationError("Budget pool not found in workspace.");
      const next = { ...p, virtualCardRef: cardRef, cardProvider: provider, updatedAt: new Date() };
      pools.set(k, next);
      return { ...next };
    },
    async recordTx(tx) {
      const row: PoolTransaction = { ...tx, id: uid("ptx"), ts: tx.ts ?? new Date() };
      txs.push(row);
      return row;
    },
    async reservedForApproval(poolId, workspaceId, approvalId) {
      // Reserved = encumbered − released − spent for this approval.
      // Derived from the append-only tx log (single source of truth).
      let reserved = 0;
      for (const t of txs) {
        if (t.poolId !== poolId || t.workspaceId !== workspaceId || t.approvalId !== approvalId) continue;
        if (t.kind === "encumber") reserved += t.amountCents;
        else if (t.kind === "release" || t.kind === "spend") reserved -= t.amountCents;
      }
      return Math.max(0, reserved);
    },
    async listTxs(poolId, workspaceId, limit = 200) {
      return txs
        .filter((t) => t.poolId === poolId && t.workspaceId === workspaceId)
        .slice(-limit)
        .reverse();
    },
    async list(workspaceId, clientId) {
      return [...pools.values()]
        .filter((p) => p.workspaceId === workspaceId && (!clientId || p.clientId === clientId))
        .map((p) => ({ ...p }));
    },
  };
}
