// Marketr — Phase 7 F2: recycling brief audit log.
//
// Workspace-isolated, append-only, hash-chained (event_hash =
// sha256(prev_hash || canonical(ts, brief_id, actor, action, payload_hash))).
// Brief creation, approval, rewrite proposals, variant routing, regeneration,
// and blocked publish attempts are all logged — the same IAB event-bus
// pattern as the Phase 5 media approval log.

import { canonicalize } from "@/lib/media/approvals";
import { sha256Hex } from "@/lib/media/safety";
import { createId } from "@/lib/media/ids";

export type RecyclingAuditAction =
  | "brief_created"
  | "brief_approved"
  | "brief_rejected"
  | "rewrite_proposed"
  | "variant_routed"
  | "asset_regenerated"
  | "publish_blocked";

export interface RecyclingAuditEvent {
  id: string;
  briefId: string;
  workspaceId: string;
  ts: Date;
  actor: string;
  action: RecyclingAuditAction;
  payloadHash: string;
  prevHash: string;
  eventHash: string;
  detail: Record<string, unknown> | null;
}

export interface RecyclingAuditInput {
  briefId: string;
  workspaceId: string;
  actor: string;
  action: RecyclingAuditAction;
  detail?: Record<string, unknown> | null;
  ts?: Date;
}

export interface RecyclingAuditStore {
  log(input: RecyclingAuditInput): Promise<RecyclingAuditEvent>;
  list(briefId: string, workspaceId: string, limit?: number): Promise<RecyclingAuditEvent[]>;
  /** Verify the hash chain for one brief. */
  verifyChain(briefId: string, workspaceId: string): Promise<{ ok: true } | { ok: false; brokenAt: string }>;
}

export function auditEventHash(prevHash: string, fields: {
  briefId: string; ts: string; actor: string; action: string; payloadHash: string;
}): string {
  return sha256Hex(`${prevHash}|${canonicalize(fields)}`);
}

/** In-memory twin — the verify battery runs against this. */
export function createMemoryRecyclingAuditStore(): RecyclingAuditStore {
  const events: RecyclingAuditEvent[] = [];

  const chainFor = (briefId: string, workspaceId: string) => {
    const mine = events.filter((e) => e.briefId === briefId && e.workspaceId === workspaceId);
    return mine.length ? mine[mine.length - 1].eventHash : "GENESIS";
  };

  return {
    async log(input) {
      const ts = input.ts ?? new Date();
      const payloadHash = sha256Hex(canonicalize(input.detail ?? {}));
      const prevHash = chainFor(input.briefId, input.workspaceId);
      const eventHash = auditEventHash(prevHash, {
        briefId: input.briefId,
        ts: ts.toISOString(),
        actor: input.actor,
        action: input.action,
        payloadHash,
      });
      const row: RecyclingAuditEvent = {
        id: createId(),
        briefId: input.briefId,
        workspaceId: input.workspaceId,
        ts,
        actor: input.actor,
        action: input.action,
        payloadHash,
        prevHash,
        eventHash,
        detail: input.detail ?? null,
      };
      events.push(row);
      return structuredClone(row);
    },

    async list(briefId, workspaceId, limit = 200) {
      return events
        .filter((e) => e.briefId === briefId && e.workspaceId === workspaceId)
        .slice(-limit)
        .map((e) => structuredClone(e));
    },

    async verifyChain(briefId, workspaceId) {
      const mine = events.filter((e) => e.briefId === briefId && e.workspaceId === workspaceId);
      let prev = "GENESIS";
      for (const e of mine) {
        const recomputed = auditEventHash(prev, {
          briefId: e.briefId,
          ts: e.ts.toISOString(),
          actor: e.actor,
          action: e.action,
          payloadHash: e.payloadHash,
        });
        if (recomputed !== e.eventHash) return { ok: false, brokenAt: e.id };
        prev = e.eventHash;
      }
      return { ok: true };
    },
  };
}
