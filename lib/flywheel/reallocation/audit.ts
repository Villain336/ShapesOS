// Marketr — Phase 7 F1: immutable, replayable audit log.
//
// Every proposal, policy decision (allow AND deny — denials carry the
// investigative value), signature check, execution, and breaker event is
// appended with a correlation ID. Hash-chained:
//   event_hash = sha256(prev_hash || canonical(correlationId, kind, actor, ts, payloadHash))
// Tampering with any event breaks the chain — verifyChain() replays it.

import { sha256Hex } from "@/lib/media/safety";
import { canonicalize } from "@/lib/media/approvals";
import type { AuditEvent, AuditKind } from "./types";

export interface AuditStore {
  append(e: Omit<AuditEvent, "id" | "prevHash" | "eventHash" | "payloadHash">): Promise<AuditEvent>;
  list(workspaceId: string, limit?: number): Promise<AuditEvent[]>;
  /** Test-only backdoor for tamper tests. */
  __mutateForTest?(id: string, patch: Partial<AuditEvent>): void;
}

let auditSeq = 0;
const auditId = () => `aev_${Date.now().toString(36)}_${(auditSeq++).toString(36)}`;

export function auditEventHash(prevHash: string, fields: {
  correlationId: string;
  kind: string;
  actor: string;
  ts: string;
  payloadHash: string;
}): string {
  return sha256Hex(`${prevHash}|${canonicalize(fields)}`);
}

export function createMemoryAuditStore(): AuditStore {
  const events: AuditEvent[] = [];
  return {
    async append(e) {
      const payloadHash = sha256Hex(canonicalize(e.payload));
      const prevHash = events.length ? events[events.length - 1].eventHash : "GENESIS";
      const eventHash = auditEventHash(prevHash, {
        correlationId: e.correlationId,
        kind: e.kind,
        actor: e.actor,
        ts: e.ts,
        payloadHash,
      });
      const row: AuditEvent = { ...e, id: auditId(), prevHash, eventHash, payloadHash };
      events.push(row);
      return structuredClone(row);
    },
    async list(workspaceId, limit = 500) {
      return events
        .filter((e) => e.workspaceId === workspaceId)
        .slice(-limit)
        .map((e) => structuredClone(e));
    },
    __mutateForTest(id, patch) {
      const i = events.findIndex((e) => e.id === id);
      if (i >= 0) events[i] = { ...events[i], ...patch };
    },
  };
}

export class AuditLog {
  constructor(private store: AuditStore) {}

  async append(
    workspaceId: string,
    kind: AuditKind,
    actor: string,
    payload: Record<string, unknown>,
    correlationId?: string,
    ts: Date = new Date(),
  ): Promise<AuditEvent> {
    return this.store.append({
      workspaceId,
      correlationId: correlationId ?? `corr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      kind,
      actor,
      payload,
      ts: ts.toISOString(),
    });
  }

  /** Replay the chain; returns the first broken link (null = intact). */
  async verifyChain(workspaceId: string): Promise<{ ok: boolean; brokenAt?: string }> {
    const events = await this.store.list(workspaceId, 10_000);
    let prev = "GENESIS";
    for (const e of events) {
      const payloadHash = sha256Hex(canonicalize(e.payload));
      if (payloadHash !== e.payloadHash) return { ok: false, brokenAt: e.id };
      const expected = auditEventHash(prev, {
        correlationId: e.correlationId,
        kind: e.kind,
        actor: e.actor,
        ts: e.ts,
        payloadHash: e.payloadHash,
      });
      if (expected !== e.eventHash || e.prevHash !== prev) return { ok: false, brokenAt: e.id };
      prev = e.eventHash;
    }
    return { ok: true };
  }

  async list(workspaceId: string, limit = 200): Promise<AuditEvent[]> {
    return this.store.list(workspaceId, limit);
  }
}
