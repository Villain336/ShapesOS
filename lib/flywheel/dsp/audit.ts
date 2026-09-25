// Marketr — Phase 7 F5: workspace-isolated audit log.
//
// Adapter connections, cap mappings, tripwire reports, ledger posts, and
// fee-schedule versions are all audit-logged here. Hash-chained per
// workspace (tamper-evident), mirroring the Phase 5 media audit pattern.

import { createHash } from "crypto";

export type DspAuditAction =
  | "adapter_connected"
  | "adapter_disconnected"
  | "cap_mapped"
  | "cap_revoked"
  | "tripwire_report"
  | "ledger_posted"
  | "fee_schedule_versioned"
  | "dsp_kill_executed"
  | "dsp_kill_honest_noop";

export interface DspAuditEvent {
  id: string;
  workspaceId: string;
  ts: Date;
  actor: string;
  action: DspAuditAction;
  subjectType: "adapter" | "cap_mapping" | "tripwire" | "ledger_row" | "fee_schedule" | "kill_target";
  subjectId: string | null;
  detail: Record<string, unknown>;
  payloadHash: string;
  prevHash: string;
  eventHash: string;
}

export interface DspAuditStore {
  log(input: {
    workspaceId: string;
    actor: string;
    action: DspAuditAction;
    subjectType: DspAuditEvent["subjectType"];
    subjectId?: string | null;
    detail?: Record<string, unknown>;
  }): Promise<DspAuditEvent>;
  list(workspaceId: string, limit?: number): Promise<DspAuditEvent[]>;
  verifyChain(workspaceId: string): Promise<{ ok: boolean; brokenAt?: string }>;
}

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

function canonical(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort());
}

export function createMemoryDspAuditStore(): DspAuditStore {
  const events: DspAuditEvent[] = [];
  const lastHash = (workspaceId: string): string => {
    const mine = events.filter((e) => e.workspaceId === workspaceId);
    return mine.length ? mine[mine.length - 1].eventHash : "GENESIS";
  };
  return {
    async log(input) {
      const prevHash = lastHash(input.workspaceId);
      const ts = new Date();
      const detail = input.detail ?? {};
      const payloadHash = createHash("sha256").update(canonical(detail)).digest("hex");
      const eventHash = createHash("sha256")
        .update(`${prevHash}|${ts.toISOString()}|${input.action}|${payloadHash}`)
        .digest("hex");
      const event: DspAuditEvent = {
        id: uid("dspaudit"),
        workspaceId: input.workspaceId,
        ts,
        actor: input.actor,
        action: input.action,
        subjectType: input.subjectType,
        subjectId: input.subjectId ?? null,
        detail,
        payloadHash,
        prevHash,
        eventHash,
      };
      events.push(event);
      return { ...event };
    },
    async list(workspaceId, limit = 200) {
      return events
        .filter((e) => e.workspaceId === workspaceId)
        .slice(-limit)
        .map((e) => ({ ...e }));
    },
    async verifyChain(workspaceId) {
      let prev = "GENESIS";
      for (const e of events.filter((x) => x.workspaceId === workspaceId)) {
        if (e.prevHash !== prev) return { ok: false, brokenAt: e.id };
        const recomputed = createHash("sha256")
          .update(`${e.prevHash}|${e.ts.toISOString()}|${e.action}|${e.payloadHash}`)
          .digest("hex");
        if (recomputed !== e.eventHash) return { ok: false, brokenAt: e.id };
        prev = e.eventHash;
      }
      return { ok: true };
    },
  };
}
