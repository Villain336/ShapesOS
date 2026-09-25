// Marketr — Phase 5 SAFETY: SQL stores for the media safety tables.
//
// The Phase 5 fragment (prisma/fragments/phase5-safety.prisma) is not yet
// merged into prisma/schema.prisma, so the generated Prisma client does not
// expose these models. These stores implement the same interfaces as the
// in-memory test stores (lib/media/pools.ts, approvals.ts, killswitch.ts)
// using parameterized raw SQL ($queryRawUnsafe with bound params — no string
// interpolation of values) against the snake_case columns, so the code
// compiles and runs identically before AND after the schema merge.
//
// All queries are workspace-scoped (cross-workspace access is rejected by
// the WHERE clause, not by convention). No secrets, no PANs in queries.
//
// ENUM NAMES: the fragment's enums have no @@map, so Postgres enum types are
// the PascalCase schema names (e.g. "BudgetPoolStatus"), NOT snake_case.
// All casts below use the quoted PascalCase form — verified against
// prisma/fragments/phase5-safety.prisma. If the merge renames an enum,
// these casts are the first thing to update.

import { prisma } from "@/lib/prisma";
import type {
  ApprovalStore, ApprovalEvent, MediaApproval, BuyBinding, ApprovalType,
  ApprovalMethod, ApproverRecord,
} from "./approvals";
import type { ApprovalStatus } from "./safety";
import { eventHashFor } from "./approvals";
import type {
  PoolStore, BudgetPool, PoolTransaction, PoolPeriod, PoolStatus, PoolTxKind,
} from "./pools";
import type { KillRule, KillRuleStore, KillAction } from "./killswitch";
import {
  logMediaAudit,
  mediaAuditEventHashFor,
  type MediaAuditEvent, type MediaAuditStore,
} from "./audit";
import { createId } from "./ids";
import { sha256Hex } from "./safety";
import { canonicalize } from "./approvals";

export { logMediaAudit };
export type { MediaAuditStore };

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}
function num(v: unknown): number {
  return Number(v);
}

/** True when the media safety tables exist (fragment merged + migrated). */
export async function safetyTablesReady(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe(`SELECT 1 FROM media_approvals LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

interface PoolRow {
  id: string; workspace_id: string; client_id: string; name: string; period: PoolPeriod;
  cap_cents: unknown; remaining_cents: unknown; encumbered_cents: unknown; currency: string;
  platform_allowlist: string[]; auto_approve_threshold_cents: unknown; alert_thresholds_json: unknown;
  virtual_card_ref: string | null; card_provider: "brex" | "ramp" | "fake"; status: PoolStatus;
  created_by: string; created_at: unknown; updated_at: unknown;
}

const POOL_COLS = `id, workspace_id, client_id, name, period, cap_cents, remaining_cents, encumbered_cents, currency, platform_allowlist, auto_approve_threshold_cents, alert_thresholds_json, virtual_card_ref, card_provider, status, created_by, created_at, updated_at`;

function toPool(r: PoolRow): BudgetPool {
  return {
    id: r.id, workspaceId: r.workspace_id, clientId: r.client_id, name: r.name,
    period: r.period, capCents: num(r.cap_cents), remainingCents: num(r.remaining_cents),
    encumberedCents: num(r.encumbered_cents), currency: r.currency,
    platformAllowlist: r.platform_allowlist ?? [],
    autoApproveThresholdCents: num(r.auto_approve_threshold_cents),
    alertThresholds: Array.isArray(r.alert_thresholds_json) ? (r.alert_thresholds_json as number[]) : [50, 75, 90],
    virtualCardRef: r.virtual_card_ref, cardProvider: r.card_provider, status: r.status,
    createdBy: r.created_by, createdAt: toDate(r.created_at), updatedAt: toDate(r.updated_at),
  };
}

interface TxRow {
  id: string; pool_id: string; workspace_id: string; approval_id: string | null; kind: PoolTxKind;
  amount_cents: unknown; running_remaining_cents: unknown; running_encumbered_cents: unknown;
  actor: string; ts: unknown; note: string | null;
}

function toTx(r: TxRow): PoolTransaction {
  return {
    id: r.id, poolId: r.pool_id, workspaceId: r.workspace_id, approvalId: r.approval_id,
    kind: r.kind, amountCents: num(r.amount_cents),
    runningRemainingCents: num(r.running_remaining_cents),
    runningEncumberedCents: num(r.running_encumbered_cents),
    actor: r.actor, ts: toDate(r.ts), note: r.note,
  };
}

export class SqlPoolStore implements PoolStore {
  async get(poolId: string, workspaceId: string): Promise<BudgetPool | null> {
    const rows = await prisma.$queryRawUnsafe<PoolRow[]>(
      `SELECT ${POOL_COLS} FROM budget_pools WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      poolId, workspaceId,
    );
    return rows[0] ? toPool(rows[0]) : null;
  }

  async create(input: Omit<BudgetPool, "id" | "createdAt" | "updatedAt">): Promise<BudgetPool> {
    const id = createId();
    const rows = await prisma.$queryRawUnsafe<PoolRow[]>(
      `INSERT INTO budget_pools (${POOL_COLS}) VALUES ($1,$2,$3,$4,$5::"BudgetPoolPeriod",$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::"CardProvider",$15::"BudgetPoolStatus",$16, NOW(), NOW())
       RETURNING ${POOL_COLS}`,
      id, input.workspaceId, input.clientId, input.name, input.period, input.capCents,
      input.remainingCents, input.encumberedCents, input.currency, input.platformAllowlist,
      input.autoApproveThresholdCents, JSON.stringify(input.alertThresholds),
      input.virtualCardRef, input.cardProvider, input.status, input.createdBy,
    );
    return toPool(rows[0]);
  }

  async tryEncumber(poolId: string, workspaceId: string, amountCents: number): Promise<BudgetPool | null> {
    // ATOMIC: the predicate (status=active AND remaining >= amount) is
    // evaluated in the same UPDATE — concurrent approvals cannot
    // double-count the same cents. This is the SQL twin of the
    // memory store's synchronous check-and-set, and the hard guard against
    // the €7,937/day over-spend class.
    const rows = await prisma.$queryRawUnsafe<PoolRow[]>(
      `UPDATE budget_pools
       SET remaining_cents = remaining_cents - $3,
           encumbered_cents = encumbered_cents + $3,
           status = CASE WHEN remaining_cents - $3 <= 0 THEN 'exhausted'::"BudgetPoolStatus" ELSE status END,
           updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2
         AND status = 'active'::"BudgetPoolStatus"
         AND remaining_cents >= $3
       RETURNING ${POOL_COLS}`,
      poolId, workspaceId, amountCents,
    );
    return rows[0] ? toPool(rows[0]) : null;
  }

  async release(poolId: string, workspaceId: string, amountCents: number): Promise<BudgetPool> {
    const rows = await prisma.$queryRawUnsafe<PoolRow[]>(
      `UPDATE budget_pools
       SET encumbered_cents = GREATEST(0, encumbered_cents - $3),
           remaining_cents = remaining_cents + LEAST($3, encumbered_cents),
           status = CASE WHEN status = 'exhausted'::"BudgetPoolStatus" AND remaining_cents + LEAST($3, encumbered_cents) > 0
                         THEN 'active'::"BudgetPoolStatus" ELSE status END,
           updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2
       RETURNING ${POOL_COLS}`,
      poolId, workspaceId, amountCents,
    );
    if (!rows[0]) throw new Error("Budget pool not found in workspace.");
    return toPool(rows[0]);
  }

  async convertToSpend(poolId: string, workspaceId: string, amountCents: number): Promise<BudgetPool> {
    const rows = await prisma.$queryRawUnsafe<PoolRow[]>(
      `UPDATE budget_pools
       SET encumbered_cents = GREATEST(0, encumbered_cents - $3), updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2
       RETURNING ${POOL_COLS}`,
      poolId, workspaceId, amountCents,
    );
    if (!rows[0]) throw new Error("Budget pool not found in workspace.");
    return toPool(rows[0]);
  }

  async freeze(poolId: string, workspaceId: string): Promise<BudgetPool> {
    const rows = await prisma.$queryRawUnsafe<PoolRow[]>(
      `UPDATE budget_pools SET status = 'frozen'::"BudgetPoolStatus", updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2 RETURNING ${POOL_COLS}`,
      poolId, workspaceId,
    );
    if (!rows[0]) throw new Error("Budget pool not found in workspace.");
    return toPool(rows[0]);
  }

  async unfreeze(poolId: string, workspaceId: string): Promise<BudgetPool> {
    const rows = await prisma.$queryRawUnsafe<PoolRow[]>(
      `UPDATE budget_pools
       SET status = CASE WHEN remaining_cents <= 0 THEN 'exhausted'::"BudgetPoolStatus" ELSE 'active'::"BudgetPoolStatus" END,
           updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2 RETURNING ${POOL_COLS}`,
      poolId, workspaceId,
    );
    if (!rows[0]) throw new Error("Budget pool not found in workspace.");
    return toPool(rows[0]);
  }

  async attachVirtualCard(poolId: string, workspaceId: string, cardRef: string, provider: BudgetPool["cardProvider"]): Promise<BudgetPool> {
    const rows = await prisma.$queryRawUnsafe<PoolRow[]>(
      `UPDATE budget_pools SET virtual_card_ref = $3, card_provider = $4::"CardProvider", updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2 RETURNING ${POOL_COLS}`,
      poolId, workspaceId, cardRef, provider,
    );
    if (!rows[0]) throw new Error("Budget pool not found in workspace.");
    return toPool(rows[0]);
  }

  async recordTx(tx: Omit<PoolTransaction, "id" | "ts"> & { ts?: Date }): Promise<PoolTransaction> {
    const rows = await prisma.$queryRawUnsafe<TxRow[]>(
      `INSERT INTO pool_transactions (id, pool_id, workspace_id, approval_id, kind, amount_cents, running_remaining_cents, running_encumbered_cents, actor, ts, note)
       VALUES ($1,$2,$3,$4,$5::"PoolTransactionKind",$6,$7,$8,$9, NOW(), $10)
       RETURNING id, pool_id, workspace_id, approval_id, kind, amount_cents, running_remaining_cents, running_encumbered_cents, actor, ts, note`,
      createId(), tx.poolId, tx.workspaceId, tx.approvalId, tx.kind, tx.amountCents,
      tx.runningRemainingCents, tx.runningEncumberedCents, tx.actor, tx.note ?? null,
    );
    return toTx(rows[0]);
  }

  async listTxs(poolId: string, workspaceId: string, limit = 200): Promise<PoolTransaction[]> {
    const rows = await prisma.$queryRawUnsafe<TxRow[]>(
      `SELECT id, pool_id, workspace_id, approval_id, kind, amount_cents, running_remaining_cents, running_encumbered_cents, actor, ts, note
       FROM pool_transactions WHERE pool_id = $1 AND workspace_id = $2 ORDER BY ts DESC LIMIT $3`,
      poolId, workspaceId, limit,
    );
    return rows.map(toTx);
  }

  async reservedForApproval(poolId: string, workspaceId: string, approvalId: string): Promise<number> {
    // Reserved = encumber − release − spend for this approval, from the
    // append-only ledger. Fail closed: no rows → 0.
    const rows = await prisma.$queryRawUnsafe<Array<{ reserved: string | number }>>(
      `SELECT COALESCE(SUM(CASE
         WHEN kind = 'encumber'::"PoolTransactionKind" THEN amount_cents
         WHEN kind IN ('release'::"PoolTransactionKind", 'spend'::"PoolTransactionKind") THEN -amount_cents
         ELSE 0 END), 0) AS reserved
       FROM pool_transactions WHERE pool_id = $1 AND workspace_id = $2 AND approval_id = $3`,
      poolId, workspaceId, approvalId,
    );
    return Math.max(0, Number(rows[0]?.reserved ?? 0));
  }

  async list(workspaceId: string, clientId?: string): Promise<BudgetPool[]> {
    const rows = clientId
      ? await prisma.$queryRawUnsafe<PoolRow[]>(
          `SELECT ${POOL_COLS} FROM budget_pools WHERE workspace_id = $1 AND client_id = $2 ORDER BY created_at DESC`,
          workspaceId, clientId,
        )
      : await prisma.$queryRawUnsafe<PoolRow[]>(
          `SELECT ${POOL_COLS} FROM budget_pools WHERE workspace_id = $1 ORDER BY created_at DESC`,
          workspaceId,
        );
    return rows.map(toPool);
  }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string; workspace_id: string; client_id: string | null; type: ApprovalType;
  status: ApprovalStatus; binding_json: unknown; binding_hash: string;
  max_spend_cents: unknown; currency: string; pool_id: string | null;
  quote_id: string | null; quote_expires_at: unknown; drift_tolerance_json: unknown;
  created_by: string; approvers_json: unknown; two_person_satisfied: boolean;
  approval_method: ApprovalMethod; approval_receipt: string | null;
  approvals_expires_at: unknown; approved_at: unknown; revoked_at: unknown;
  revoked_by: string | null; executed_at: unknown; created_at: unknown; updated_at: unknown;
}

const APPROVAL_COLS = `id, workspace_id, client_id, type, status, binding_json, binding_hash, max_spend_cents, currency, pool_id, quote_id, quote_expires_at, drift_tolerance_json, created_by, approvers_json, two_person_satisfied, approval_method, approval_receipt, approvals_expires_at, approved_at, revoked_at, revoked_by, executed_at, created_at, updated_at`;

function toApproval(r: ApprovalRow): MediaApproval {
  return {
    id: r.id, workspaceId: r.workspace_id, clientId: r.client_id, type: r.type,
    status: r.status, binding: r.binding_json as BuyBinding, bindingHash: r.binding_hash,
    maxSpendCents: num(r.max_spend_cents), currency: r.currency, poolId: r.pool_id,
    quoteId: r.quote_id, quoteExpiresAt: r.quote_expires_at ? toDate(r.quote_expires_at) : null,
    driftTolerance: r.drift_tolerance_json as { pricePct: number; spendPct: number },
    createdBy: r.created_by, approvers: (r.approvers_json ?? []) as ApproverRecord[],
    twoPersonSatisfied: r.two_person_satisfied, approvalMethod: r.approval_method,
    approvalReceipt: r.approval_receipt,
    approvalsExpiresAt: r.approvals_expires_at ? toDate(r.approvals_expires_at) : null,
    approvedAt: r.approved_at ? toDate(r.approved_at) : null,
    revokedAt: r.revoked_at ? toDate(r.revoked_at) : null,
    revokedBy: r.revoked_by,
    executedAt: r.executed_at ? toDate(r.executed_at) : null,
    createdAt: toDate(r.created_at), updatedAt: toDate(r.updated_at),
  };
}

interface EventRow {
  id: string; approval_id: string; workspace_id: string; ts: unknown; actor: string;
  action: ApprovalEvent["action"]; payload_hash: string; prev_hash: string;
  event_hash: string; detail: unknown;
}

function toEvent(r: EventRow): ApprovalEvent {
  return {
    id: r.id, approvalId: r.approval_id, workspaceId: r.workspace_id, ts: toDate(r.ts),
    actor: r.actor, action: r.action, payloadHash: r.payload_hash, prevHash: r.prev_hash,
    eventHash: r.event_hash, detail: (r.detail ?? null) as Record<string, unknown> | null,
  };
}

export class SqlApprovalStore implements ApprovalStore {
  async create(a: Omit<MediaApproval, "id" | "createdAt" | "updatedAt">): Promise<MediaApproval> {
    const id = createId();
    const rows = await prisma.$queryRawUnsafe<ApprovalRow[]>(
      `INSERT INTO media_approvals (${APPROVAL_COLS})
       VALUES ($1,$2,$3,$4::"MediaApprovalType",$5::"MediaApprovalStatus",$6::jsonb,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16,$17::"MediaApprovalMethod",$18,$19,$20,$21,$22,$23, NOW(), NOW())
       RETURNING ${APPROVAL_COLS}`,
      id, a.workspaceId, a.clientId, a.type, a.status, JSON.stringify(a.binding), a.bindingHash,
      a.maxSpendCents, a.currency, a.poolId, a.quoteId,
      a.quoteExpiresAt ?? null,
      JSON.stringify(a.driftTolerance), a.createdBy, JSON.stringify(a.approvers),
      a.twoPersonSatisfied, a.approvalMethod, a.approvalReceipt,
      a.approvalsExpiresAt ?? null,
      a.approvedAt ?? null,
      a.revokedAt ?? null, a.revokedBy,
      a.executedAt ?? null,
    );
    return toApproval(rows[0]);
  }

  async get(id: string, workspaceId: string): Promise<MediaApproval | null> {
    const rows = await prisma.$queryRawUnsafe<ApprovalRow[]>(
      `SELECT ${APPROVAL_COLS} FROM media_approvals WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      id, workspaceId,
    );
    return rows[0] ? toApproval(rows[0]) : null;
  }

  async update(id: string, workspaceId: string, patch: Partial<MediaApproval>): Promise<MediaApproval> {
    // Only allowlisted fields are updatable — binding_json is deliberately
    // excluded: the binding is immutable after creation (tamper = new version).
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const set = (col: string, cast: string | null, val: unknown) => {
      sets.push(`${col} = $${i}${cast ? `::"${cast}"` : ""}`);
      params.push(val);
      i++;
    };
    if (patch.status !== undefined) set("status", "MediaApprovalStatus", patch.status);
    if (patch.approvers !== undefined) set("approvers_json", "jsonb", JSON.stringify(patch.approvers));
    if (patch.twoPersonSatisfied !== undefined) set("two_person_satisfied", null, patch.twoPersonSatisfied);
    if (patch.approvalMethod !== undefined) set("approval_method", "MediaApprovalMethod", patch.approvalMethod);
    if (patch.approvalReceipt !== undefined) set("approval_receipt", null, patch.approvalReceipt);
    if (patch.approvalsExpiresAt !== undefined) set("approvals_expires_at", null, patch.approvalsExpiresAt ?? null);
    if (patch.approvedAt !== undefined) set("approved_at", null, patch.approvedAt ?? null);
    if (patch.revokedAt !== undefined) set("revoked_at", null, patch.revokedAt ?? null);
    if (patch.revokedBy !== undefined) set("revoked_by", null, patch.revokedBy);
    if (patch.executedAt !== undefined) set("executed_at", null, patch.executedAt ?? null);
    if (sets.length === 0) {
      const cur = await this.get(id, workspaceId);
      if (!cur) throw new Error("Approval not found in workspace.");
      return cur;
    }
    sets.push(`updated_at = NOW()`);
    params.push(id, workspaceId);
    const rows = await prisma.$queryRawUnsafe<ApprovalRow[]>(
      `UPDATE media_approvals SET ${sets.join(", ")} WHERE id = $${i} AND workspace_id = $${i + 1} RETURNING ${APPROVAL_COLS}`,
      ...params,
    );
    if (!rows[0]) throw new Error("Approval not found in workspace.");
    return toApproval(rows[0]);
  }

  async list(workspaceId: string, status?: ApprovalStatus, limit = 200): Promise<MediaApproval[]> {
    const rows = status
      ? await prisma.$queryRawUnsafe<ApprovalRow[]>(
          `SELECT ${APPROVAL_COLS} FROM media_approvals WHERE workspace_id = $1 AND status = $2::"MediaApprovalStatus" ORDER BY created_at DESC LIMIT $3`,
          workspaceId, status, limit,
        )
      : await prisma.$queryRawUnsafe<ApprovalRow[]>(
          `SELECT ${APPROVAL_COLS} FROM media_approvals WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
          workspaceId, limit,
        );
    return rows.map(toApproval);
  }

  async listPendingForClient(workspaceId: string, clientId: string): Promise<MediaApproval[]> {
    const rows = await prisma.$queryRawUnsafe<ApprovalRow[]>(
      `SELECT ${APPROVAL_COLS} FROM media_approvals WHERE workspace_id = $1 AND client_id = $2 AND status = 'pending'::"MediaApprovalStatus" ORDER BY created_at DESC`,
      workspaceId, clientId,
    );
    return rows.map(toApproval);
  }

  async appendEvent(e: Omit<ApprovalEvent, "id" | "ts" | "prevHash" | "eventHash"> & { ts?: Date }): Promise<ApprovalEvent> {
    const ts = e.ts ?? new Date();
    const prevHash = await this.lastEventHash(e.approvalId, e.workspaceId);
    const id = createId();
    const eventHash = eventHashFor(prevHash, {
      approvalId: e.approvalId, ts: ts.toISOString(), actor: e.actor,
      action: e.action, payloadHash: e.payloadHash,
    });
    const rows = await prisma.$queryRawUnsafe<EventRow[]>(
      `INSERT INTO media_approval_events (id, approval_id, workspace_id, ts, actor, action, payload_hash, prev_hash, event_hash, detail)
       VALUES ($1,$2,$3,$4,$5,$6::"MediaApprovalEventAction",$7,$8,$9,$10::jsonb)
       RETURNING id, approval_id, workspace_id, ts, actor, action, payload_hash, prev_hash, event_hash, detail`,
      id, e.approvalId, e.workspaceId, ts, e.actor, e.action,
      e.payloadHash, prevHash, eventHash, e.detail ? JSON.stringify(e.detail) : null,
    );
    return toEvent(rows[0]);
  }

  async getEvents(approvalId: string, workspaceId: string, limit = 500): Promise<ApprovalEvent[]> {
    const rows = await prisma.$queryRawUnsafe<EventRow[]>(
      `SELECT id, approval_id, workspace_id, ts, actor, action, payload_hash, prev_hash, event_hash, detail
       FROM media_approval_events WHERE approval_id = $1 AND workspace_id = $2 ORDER BY ts ASC LIMIT $3`,
      approvalId, workspaceId, limit,
    );
    return rows.map(toEvent);
  }

  async lastEventHash(approvalId: string, workspaceId: string): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<{ event_hash: string }[]>(
      `SELECT event_hash FROM media_approval_events WHERE approval_id = $1 AND workspace_id = $2 ORDER BY ts DESC LIMIT 1`,
      approvalId, workspaceId,
    );
    return rows[0]?.event_hash ?? "GENESIS";
  }
}

// ---------------------------------------------------------------------------
// Kill rules
// ---------------------------------------------------------------------------

interface KillRuleRow {
  id: string; workspace_id: string; client_id: string | null; name: string;
  scope_json: unknown; condition_json: unknown; window: string; action: KillAction;
  cooldown_minutes: unknown; enabled: boolean; created_by: string;
  last_fired_at: unknown; created_at: unknown; updated_at: unknown;
}

const KILL_COLS = `id, workspace_id, client_id, name, scope_json, condition_json, "window", action, cooldown_minutes, enabled, created_by, last_fired_at, created_at, updated_at`;

function toKillRule(r: KillRuleRow): KillRule {
  return {
    id: r.id, workspaceId: r.workspace_id, clientId: r.client_id, name: r.name,
    scope: (r.scope_json ?? {}) as KillRule["scope"],
    condition: r.condition_json as KillRule["condition"],
    window: r.window, action: r.action, cooldownMinutes: Number(r.cooldown_minutes),
    enabled: r.enabled, createdBy: r.created_by,
    lastFiredAt: r.last_fired_at ? toDate(r.last_fired_at) : null,
    createdAt: toDate(r.created_at), updatedAt: toDate(r.updated_at),
  };
}

export class SqlKillRuleStore implements KillRuleStore {
  async create(r: Omit<KillRule, "id" | "createdAt" | "updatedAt" | "lastFiredAt">): Promise<KillRule> {
    const rows = await prisma.$queryRawUnsafe<KillRuleRow[]>(
      `INSERT INTO kill_rules (${KILL_COLS})
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::"KillRuleAction",$9,$10,$11,NULL, NOW(), NOW())
       RETURNING ${KILL_COLS}`,
      createId(), r.workspaceId, r.clientId, r.name, JSON.stringify(r.scope),
      JSON.stringify(r.condition), r.window, r.action, r.cooldownMinutes, r.enabled, r.createdBy,
    );
    return toKillRule(rows[0]);
  }

  async get(id: string, workspaceId: string): Promise<KillRule | null> {
    const rows = await prisma.$queryRawUnsafe<KillRuleRow[]>(
      `SELECT ${KILL_COLS} FROM kill_rules WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      id, workspaceId,
    );
    return rows[0] ? toKillRule(rows[0]) : null;
  }

  async list(workspaceId: string, enabledOnly = false): Promise<KillRule[]> {
    const rows = enabledOnly
      ? await prisma.$queryRawUnsafe<KillRuleRow[]>(
          `SELECT ${KILL_COLS} FROM kill_rules WHERE workspace_id = $1 AND enabled = true ORDER BY created_at`,
          workspaceId,
        )
      : await prisma.$queryRawUnsafe<KillRuleRow[]>(
          `SELECT ${KILL_COLS} FROM kill_rules WHERE workspace_id = $1 ORDER BY created_at`,
          workspaceId,
        );
    return rows.map(toKillRule);
  }

  async setEnabled(id: string, workspaceId: string, enabled: boolean): Promise<KillRule> {
    const rows = await prisma.$queryRawUnsafe<KillRuleRow[]>(
      `UPDATE kill_rules SET enabled = $3, updated_at = NOW() WHERE id = $1 AND workspace_id = $2 RETURNING ${KILL_COLS}`,
      id, workspaceId, enabled,
    );
    if (!rows[0]) throw new Error("Kill rule not found in workspace.");
    return toKillRule(rows[0]);
  }

  async markFired(id: string, workspaceId: string, at: Date): Promise<void> {
    await prisma.$queryRawUnsafe(
      `UPDATE kill_rules SET last_fired_at = $3, updated_at = NOW() WHERE id = $1 AND workspace_id = $2`,
      id, workspaceId, at,
    );
  }
}

// ---------------------------------------------------------------------------
// MediaBuy rows (created only by the executor after pre-flight passes)
// ---------------------------------------------------------------------------

export interface MediaBuyStore {
  create(buy: { approvalId: string; workspaceId: string; poolId: string; platform: string; clientAdAccountId: string; platformCampaignRef?: string | null; killRulesRegistered?: string[] }): Promise<void>;
  list(workspaceId: string, limit?: number): Promise<Array<{ id: string; approvalId: string; platform: string; status: string; executedAt: Date | null; actualSpendCents: number | null }>>;
}

export class SqlMediaBuyStore implements MediaBuyStore {
  async create(buy: { approvalId: string; workspaceId: string; poolId: string; platform: string; clientAdAccountId: string; platformCampaignRef?: string | null; killRulesRegistered?: string[] }): Promise<void> {
    await prisma.$queryRawUnsafe(
      `INSERT INTO media_buys (id, workspace_id, approval_id, pool_id, platform, client_ad_account_id, status, platform_campaign_ref, kill_rules_registered, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'executed'::"MediaBuyStatus",$7,$8::jsonb, NOW(), NOW())
       ON CONFLICT (approval_id) DO NOTHING`,
      createId(), buy.workspaceId, buy.approvalId, buy.poolId, buy.platform,
      buy.clientAdAccountId, buy.platformCampaignRef ?? null,
      JSON.stringify(buy.killRulesRegistered ?? []),
    );
  }

  async list(workspaceId: string, limit = 100) {
    const rows = await prisma.$queryRawUnsafe<
      { id: string; approval_id: string; platform: string; status: string; executed_at: unknown; actual_spend_cents: unknown }[]
    >(
      `SELECT id, approval_id, platform, status::text AS status, executed_at, actual_spend_cents FROM media_buys WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
      workspaceId, limit,
    );
    return rows.map((r) => ({
      id: r.id, approvalId: r.approval_id, platform: r.platform, status: r.status,
      executedAt: r.executed_at ? toDate(r.executed_at) : null,
      actualSpendCents: r.actual_spend_cents === null ? null : Number(r.actual_spend_cents),
    }));
  }
}

// ---------------------------------------------------------------------------
// Media audit events (workspace-scoped, append-only, hash-chained)
// ---------------------------------------------------------------------------

type AuditRow = {
  id: string; workspace_id: string; ts: unknown; actor: string; action: string;
  subject_type: string; subject_id: string | null; payload_hash: string;
  prev_hash: string; event_hash: string; detail: unknown;
};

function toAuditEvent(r: AuditRow): MediaAuditEvent {
  return {
    id: r.id, workspaceId: r.workspace_id, ts: toDate(r.ts), actor: r.actor,
    action: r.action as MediaAuditEvent["action"],
    subjectType: r.subject_type as MediaAuditEvent["subjectType"],
    subjectId: r.subject_id, payloadHash: r.payload_hash,
    prevHash: r.prev_hash, eventHash: r.event_hash,
    detail: (r.detail as Record<string, unknown> | null) ?? null,
  };
}

export class SqlMediaAuditStore implements MediaAuditStore {
  async lastHash(workspaceId: string): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<Array<{ event_hash: string }>>(
      `SELECT event_hash FROM media_audit_events WHERE workspace_id = $1 ORDER BY ts DESC, id DESC LIMIT 1`,
      workspaceId,
    );
    return rows[0]?.event_hash ?? "GENESIS";
  }

  async append(input: Omit<MediaAuditEvent, "id" | "ts" | "payloadHash" | "prevHash" | "eventHash"> & {
    ts?: Date; detail?: Record<string, unknown> | null;
  }): Promise<MediaAuditEvent> {
    const ts = input.ts ?? new Date();
    const detail = input.detail ?? null;
    const payloadHash = sha256Hex(canonicalize(detail ?? {}));
    const prevHash = await this.lastHash(input.workspaceId);
    const eventHash = mediaAuditEventHashFor(prevHash, {
      workspaceId: input.workspaceId, ts: ts.toISOString(), actor: input.actor,
      action: input.action, subjectType: input.subjectType,
      subjectId: input.subjectId ?? null, payloadHash,
    });
    const id = createId();
    const rows = await prisma.$queryRawUnsafe<AuditRow[]>(
      `INSERT INTO media_audit_events (id, workspace_id, ts, actor, action, subject_type, subject_id, payload_hash, prev_hash, event_hash, detail)
       VALUES ($1,$2,$3,$4,$5::"MediaAuditAction",$6,$7,$8,$9,$10,$11::jsonb)
       RETURNING id, workspace_id, ts, actor, action::text AS action, subject_type, subject_id, payload_hash, prev_hash, event_hash, detail`,
      id, input.workspaceId, ts, input.actor, input.action, input.subjectType,
      input.subjectId ?? null, payloadHash, prevHash, eventHash,
      detail === null ? null : JSON.stringify(detail),
    );
    return toAuditEvent(rows[0]);
  }

  async list(workspaceId: string, limit = 200): Promise<MediaAuditEvent[]> {
    const rows = await prisma.$queryRawUnsafe<AuditRow[]>(
      `SELECT id, workspace_id, ts, actor, action::text AS action, subject_type, subject_id, payload_hash, prev_hash, event_hash, detail
       FROM media_audit_events WHERE workspace_id = $1 ORDER BY ts DESC, id DESC LIMIT $2`,
      workspaceId, limit,
    );
    return rows.map(toAuditEvent).reverse();
  }
}

// ---------------------------------------------------------------------------
// Store factories (routes)
// ---------------------------------------------------------------------------

export function mediaStores() {
  return {
    pools: new SqlPoolStore(),
    approvals: new SqlApprovalStore(),
    killRules: new SqlKillRuleStore(),
    buys: new SqlMediaBuyStore(),
    audit: new SqlMediaAuditStore(),
  };
}
