// Marketr — Phase 6 authority audit log: hash-chained, append-only.
// Mirrors lib/media/audit.ts. Pure + memory-store twin for batteries.

import { sha256Hex, canonicalize, eventHashFor } from "./approvals";

export interface AuthorityAuditInput {
  workspaceId: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  detail?: Record<string, unknown> | null;
}

export interface AuthorityAuditEvent extends AuthorityAuditInput {
  id: string;
  ts: Date;
  payloadHash: string;
  prevHash: string;
  eventHash: string;
}

export interface AuthorityAuditStore {
  log(input: AuthorityAuditInput): AuthorityAuditEvent;
  list(workspaceId: string, limit?: number): AuthorityAuditEvent[];
  verifyChain(): { ok: boolean; brokenAt?: number };
}

let idCounter = 0;

export function createMemoryAuthorityAuditStore(): AuthorityAuditStore {
  const events: AuthorityAuditEvent[] = [];
  let lastHash = "GENESIS";

  return {
    log(input) {
      const ts = new Date();
      const payloadHash = sha256Hex(canonicalize(input.detail ?? {}));
      const ev: AuthorityAuditEvent = {
        ...input,
        id: `aae_${Date.now().toString(36)}_${(idCounter++).toString(36)}`,
        ts,
        payloadHash,
        prevHash: lastHash,
        eventHash: eventHashFor(lastHash, input.entityId, input.action, payloadHash, ts),
      };
      lastHash = ev.eventHash;
      events.push(ev);
      return ev;
    },
    list(workspaceId, limit = 200) {
      return events.filter((e) => e.workspaceId === workspaceId).slice(-limit);
    },
    verifyChain() {
      let prev = "GENESIS";
      for (let i = 0; i < events.length; i += 1) {
        const e = events[i];
        if (e.prevHash !== prev) return { ok: false, brokenAt: i };
        const recomputed = eventHashFor(e.prevHash, e.entityId, e.action, e.payloadHash, e.ts);
        if (recomputed !== e.eventHash) return { ok: false, brokenAt: i };
        prev = e.eventHash;
      }
      return { ok: true };
    },
  };
}
