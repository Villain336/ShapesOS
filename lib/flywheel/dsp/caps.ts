// Marketr — Phase 7 F5: approval-object ↔ DSP cap mapping.
//
// A human-signed Phase 5 approval object maps onto an ENFORCEABLE DSP-level
// budget cap. Invariants:
//   - capCents can never exceed the approval's maxSpendCents;
//   - a revoked, expired, or non-approved approval maps to NOTHING (fail
//     closed — the mapping is void, and any mapped cap is revoked);
//   - the mapping is audit-logged (lib/flywheel/dsp/audit.ts).

import { DspKind } from "./types";

export type DspCapStatus = "mapped" | "revoked" | "superseded";

export interface ApprovalLike {
  id: string;
  workspaceId: string;
  status: "draft" | "pending" | "approved" | "executed" | "expired" | "revoked";
  maxSpendCents: number;
  approvalExpiresAt?: Date | null;
  approvedAt?: Date | null;
}

export interface DspCapMapping {
  id: string;
  workspaceId: string;
  approvalId: string;
  dsp: DspKind;
  /** DSP-native campaign or line-item reference the cap applies to. */
  platformRef: string;
  capCents: number;
  /** Floor/ceiling: never above the signed approval's max spend. */
  approvalMaxSpendCents: number;
  status: DspCapStatus;
  mappedBy: string;
  mappedAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export interface DspCapStore {
  map(input: Omit<DspCapMapping, "id" | "status" | "mappedAt" | "revokedAt" | "revokedReason">): Promise<DspCapMapping>;
  revoke(id: string, workspaceId: string, reason: string, actor: string): Promise<DspCapMapping>;
  get(workspaceId: string, id: string): Promise<DspCapMapping | null>;
  list(workspaceId: string, dsp?: DspKind): Promise<DspCapMapping[]>;
  listForApproval(workspaceId: string, approvalId: string): Promise<DspCapMapping[]>;
}

/** Validate an approval can back a DSP cap right now. Throws to fail closed. */
export function assertApprovalBackable(approval: ApprovalLike, now: Date = new Date()): void {
  if (approval.status !== "approved" && approval.status !== "executed") {
    throw new Error(
      `Approval ${approval.id} cannot back a DSP cap: status is "${approval.status}", expected approved/executed.`,
    );
  }
  if (approval.approvalExpiresAt && approval.approvalExpiresAt <= now) {
    throw new Error(`Approval ${approval.id} has expired — DSP cap mapping denied (fail closed).`);
  }
}

export function approvalCapCents(approval: ApprovalLike): number {
  return approval.maxSpendCents;
}

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export function createMemoryDspCapStore(): DspCapStore {
  const rows: DspCapMapping[] = [];
  return {
    async map(input) {
      if (!Number.isInteger(input.capCents) || input.capCents <= 0) {
        throw new Error("capCents must be a positive integer.");
      }
      // A human-signed cap is enforceable at the platform only UP TO the
      // signed amount — never above.
      if (input.capCents > input.approvalMaxSpendCents) {
        throw new Error(
          `DSP cap ($${(input.capCents / 100).toFixed(2)}) exceeds the signed approval's max spend ` +
            `($${(input.approvalMaxSpendCents / 100).toFixed(2)}). Cap mapping denied.`,
        );
      }
      // Supersede older live mappings for the same platform ref.
      for (const r of rows) {
        if (
          r.workspaceId === input.workspaceId &&
          r.platformRef === input.platformRef &&
          r.status === "mapped"
        ) {
          r.status = "superseded";
        }
      }
      const row: DspCapMapping = {
        ...input,
        id: uid("dspcap"),
        status: "mapped",
        mappedAt: new Date(),
        revokedAt: null,
        revokedReason: null,
      };
      rows.push(row);
      return { ...row };
    },
    async revoke(id, workspaceId, reason, actor) {
      void actor;
      const r = rows.find((x) => x.workspaceId === workspaceId && x.id === id);
      if (!r) throw new Error(`DSP cap mapping not found: ${id}.`);
      r.status = "revoked";
      r.revokedAt = new Date();
      r.revokedReason = reason;
      return { ...r };
    },
    async get(workspaceId, id) {
      const r = rows.find((x) => x.workspaceId === workspaceId && x.id === id);
      return r ? { ...r } : null;
    },
    async list(workspaceId, dsp) {
      return rows
        .filter((r) => r.workspaceId === workspaceId && (!dsp || r.dsp === dsp))
        .map((r) => ({ ...r }));
    },
    async listForApproval(workspaceId, approvalId) {
      return rows
        .filter((r) => r.workspaceId === workspaceId && r.approvalId === approvalId)
        .map((r) => ({ ...r }));
    },
  };
}

/**
 * Re-check every mapped cap against its approval's CURRENT status (the
 * kill-switch path calls this): a revoked/expired approval instantly voids
 * its DSP caps. Returns the mappings that were revoked by this pass.
 */
export async function reverifyCapMappings(
  store: DspCapStore,
  workspaceId: string,
  approvalFor: (approvalId: string) => Promise<ApprovalLike | null>,
  now: Date = new Date(),
): Promise<DspCapMapping[]> {
  const live = (await store.list(workspaceId)).filter((m) => m.status === "mapped");
  const revoked: DspCapMapping[] = [];
  for (const m of live) {
    const approval = await approvalFor(m.approvalId);
    const voided =
      !approval ||
      approval.status === "revoked" ||
      approval.status === "expired" ||
      (approval.approvalExpiresAt && approval.approvalExpiresAt <= now);
    if (voided) {
      revoked.push(
        await store.revoke(m.id, workspaceId, "approval revoked/expired — DSP cap voided (fail closed)", "system"),
      );
    }
  }
  return revoked;
}
