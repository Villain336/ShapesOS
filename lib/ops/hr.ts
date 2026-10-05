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

// ---------------------------------------------------------------------------
// Phase 10 (ops-core): recruiting. Applicants move through
// applied → screening → interview → offer → hired / rejected on a kanban;
// moving one to "hired" creates their OpsTeamMember once (department from
// the opening) and links it back.
// ---------------------------------------------------------------------------

export async function createApplicantRow(tx: Tx, actor: { workspaceId: string; userId: string }, body: Record<string, unknown>) {
  const opening = await tx.opsJobOpening.findFirst({ where: { id: String(body.openingId), workspaceId: actor.workspaceId } });
  if (!opening) throw new OpsError(404, `job-openings "${String(body.openingId)}" not found in workspace`);
  if (opening.status === "closed") throw new OpsError(422, `"${opening.title}" is closed to new applicants`);
  return tx.opsApplicant.create({
    data: {
      workspaceId: actor.workspaceId,
      openingId: opening.id,
      name: String(body.name),
      email: (body.email as string | undefined) ?? null,
      phone: (body.phone as string | undefined) ?? null,
      source: (body.source as string | undefined) ?? null,
      stage: (body.stage as "applied") ?? "applied",
      rating: (body.rating as number | undefined) ?? null,
      notes: (body.notes as string | undefined) ?? null,
    },
  }) as unknown as Promise<Record<string, unknown>>;
}

export async function patchApplicantRow(
  tx: Tx,
  actor: { workspaceId: string; userId: string },
  id: string,
  patch: Record<string, unknown>,
  existing: Record<string, unknown>,
) {
  const data: Record<string, unknown> = { ...patch };
  if (patch.stage === "hired" && !existing.hiredMemberId) {
    const opening = await tx.opsJobOpening.findFirst({ where: { id: String(existing.openingId), workspaceId: actor.workspaceId } });
    const member = await tx.opsTeamMember.create({
      data: {
        workspaceId: actor.workspaceId,
        name: String(existing.name),
        email: (patch.email as string | undefined) ?? (existing.email as string | null) ?? null,
        title: opening?.title ?? null,
        departmentId: opening?.departmentId ?? null,
        startDate: new Date(),
      },
    });
    data.hiredMemberId = member.id;
  }
  // Guard the move on the stage we read, so a double "hired" can't create
  // two team members.
  const claimed = await tx.opsApplicant.updateMany({ where: { id, workspaceId: actor.workspaceId, stage: existing.stage as "applied" }, data });
  if (claimed.count !== 1) throw new OpsError(409, "Applicant changed concurrently — reload and retry");
  return (await tx.opsApplicant.findFirst({ where: { id, workspaceId: actor.workspaceId } })) as unknown as Record<string, unknown>;
}
