// Marketr — Phase 17 slice 5: HR essentials service helpers.
//
// Leave request lifecycle: requested → approved / denied → taken.
// Denied and taken are terminal. Approving goes through the Phase 14 gate
// (OPS_LEAVE_APPROVE); the service only records the decision metadata.
//
// Leave approvals are decided by whoever holds approval rights on the
// workspace (the same editor+ gate as every other ops gated write —
// lib/ops/gate.ts). No parallel permission system: the generic ops route
// already requires editor+ for mutations, and Phase 14 approvals are
// approved in the Actions queue or inline by a person with approval rights.

import type { Prisma } from "@prisma/client";
import { OpsError } from "./doctype";

/** Legal status flow for leave requests. Terminal states have no exits. */
export function assertLegalLeaveTransition(from: string, to: string): void {
  const legal: Record<string, string[]> = {
    requested: ["approved", "denied"],
    approved: ["taken"],
    denied: [],
    taken: [],
  };
  if (!(legal[from] ?? []).includes(to)) {
    throw new OpsError(
      422,
      `Illegal leave transition "${from}" → "${to}" (requested → approved/denied → taken)`,
    );
  }
}

export interface LeaveMemberRef {
  id: string;
  name: string;
  title: string | null;
}

type Tx = Prisma.TransactionClient;

/** Resolve leave-request memberIds to display names for the UI. */
export async function resolveMemberNames(
  tx: Tx,
  workspaceId: string,
  ids: string[],
): Promise<LeaveMemberRef[]> {
  if (ids.length === 0) return [];
  const rows = (await (
    tx as unknown as {
      opsTeamMember: {
        findMany(a: unknown): Promise<Array<{ id: string; name: string; title: string | null }>>;
      };
    }
  ).opsTeamMember.findMany({
    where: { id: { in: ids }, workspaceId },
    select: { id: true, name: true, title: true },
  })) as LeaveMemberRef[];
  return rows;
}
