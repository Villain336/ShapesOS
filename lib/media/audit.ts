// Marketr — Phase 5 SAFETY: workspace-scoped append-only audit.
//
// Covers money-adjacent safety mutations that belong to no single approval:
// pool create/freeze/unfreeze, virtual-card issue/attach, kill-rule
// create/toggle/seed, emergency stop, buy execution/halt. Hash-chained per
// workspace (tamper-evident), complementing media_approval_events
// (approval-scoped) and pool_transactions (pool-ledger-scoped).
//
// Every mutation route under app/api/media/* writes here. The chain head is
// exportable for compliance review.

import { sha256Hex } from "./safety";
import { canonicalize } from "./approvals";
import { createId } from "./ids";

export type MediaAuditAction =
  | "pool_created" | "pool_frozen" | "pool_unfrozen"
  | "virtual_card_issued" | "virtual_card_attached"
  | "kill_rule_created" | "kill_rule_toggled" | "kill_rule_pack_seeded"
  | "emergency_stop" | "buy_executed" | "buy_execution_halted";

export type MediaAuditSubjectType = "pool" | "kill_rule" | "approval" | "workspace";

export interface MediaAuditEvent {
  id: string;
  workspaceId: string;
  ts: Date;
  actor: string;
  action: MediaAuditAction;
  subjectType: MediaAuditSubjectType;
  subjectId: string | null;
  payloadHash: string;
  prevHash: string;
  eventHash: string;
  detail: Record<string, unknown> | null;
}

export function mediaAuditEventHashFor(
  prevHash: string,
  fields: {
    workspaceId: string; ts: string; actor: string; action: string;
    subjectType: string; subjectId: string | null; payloadHash: string;
  },
): string {
  return sha256Hex(
    prevHash + "|" + canonicalize({
      workspace_id: fields.workspaceId, ts: fields.ts, actor: fields.actor,
      action: fields.action, subject_type: fields.subjectType,
      subject_id: fields.subjectId, payload_hash: fields.payloadHash,
    }),
  );
}

export interface MediaAuditStore {
  append(event: Omit<MediaAuditEvent, "id" | "ts" | "payloadHash" | "prevHash" | "eventHash"> & {
    ts?: Date; detail?: Record<string, unknown> | null;
  }): Promise<MediaAuditEvent>;
  lastHash(workspaceId: string): Promise<string>;
  list(workspaceId: string, limit?: number): Promise<MediaAuditEvent[]>;
}

/** Append-only: memory implementation (tests). */
export function createMemoryMediaAuditStore(): MediaAuditStore {
  const events: MediaAuditEvent[] = [];
  const heads = new Map<string, string>();
  return {
    async append(input) {
      const ts = input.ts ?? new Date();
      const payloadHash = sha256Hex(canonicalize(input.detail ?? {}));
      const prevHash = heads.get(input.workspaceId) ?? "GENESIS";
      const eventHash = mediaAuditEventHashFor(prevHash, {
        workspaceId: input.workspaceId, ts: ts.toISOString(), actor: input.actor,
        action: input.action, subjectType: input.subjectType,
        subjectId: input.subjectId ?? null, payloadHash,
      });
      const row: MediaAuditEvent = {
        id: createId(), workspaceId: input.workspaceId, ts, actor: input.actor,
        action: input.action, subjectType: input.subjectType,
        subjectId: input.subjectId ?? null, payloadHash, prevHash, eventHash,
        detail: input.detail ?? null,
      };
      events.push(row);
      heads.set(input.workspaceId, eventHash);
      return { ...row };
    },
    async lastHash(workspaceId) {
      return heads.get(workspaceId) ?? "GENESIS";
    },
    async list(workspaceId, limit = 200) {
      return events.filter((e) => e.workspaceId === workspaceId).slice(-limit).map((e) => ({ ...e }));
    },
  };
}

/**
 * Convenience: log one audit event. Never throws on logging failure —
 * callers should not turn an audit-write failure into a mutation failure,
 * but MUST surface it (the returned promise rejects loudly if the store
 * itself is broken; route handlers catch and report).
 */
export async function logMediaAudit(
  store: MediaAuditStore,
  input: {
    workspaceId: string;
    actor: string;
    action: MediaAuditAction;
    subjectType: MediaAuditSubjectType;
    subjectId?: string | null;
    detail?: Record<string, unknown> | null;
  },
): Promise<MediaAuditEvent> {
  return store.append({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId ?? null,
    detail: input.detail ?? null,
  });
}

/** Verify a workspace's audit chain (tamper evidence). */
export async function verifyMediaAuditChain(
  store: MediaAuditStore,
  workspaceId: string,
): Promise<{ ok: boolean; events: number; brokenAt?: string }> {
  const events = await store.list(workspaceId, 10000);
  let prev = "GENESIS";
  for (const e of events) {
    const recomputed = mediaAuditEventHashFor(prev, {
      workspaceId: e.workspaceId, ts: e.ts.toISOString(), actor: e.actor,
      action: e.action, subjectType: e.subjectType,
      subjectId: e.subjectId, payloadHash: e.payloadHash,
    });
    if (recomputed !== e.eventHash || e.prevHash !== prev) {
      return { ok: false, events: events.length, brokenAt: e.id };
    }
    prev = e.eventHash;
  }
  return { ok: true, events: events.length };
}
