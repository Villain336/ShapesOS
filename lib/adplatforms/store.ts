// Marketr — Phase 18 slice 1: Prisma-backed gate ports.
//
// Production implementations of the SpendProposalStore / SpendApprovalStore
// ports from ./gate.ts. SpendApproval rows are insert-only by construction —
// this module exposes no update or delete.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  SpendApproval,
  SpendApprovalStore,
  SpendProposal,
  SpendProposalKind,
  SpendProposalStatus,
  SpendProposalStore,
} from "./gate";

function toProposal(row: {
  id: string;
  workspaceId: string;
  kind: string;
  action: string;
  targetType: string;
  targetId: string;
  payload: unknown;
  scopeHash: string;
  status: string;
  proposedBy: string;
  proposedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  expiresAt: Date;
}): SpendProposal {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as SpendProposalKind,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    scopeHash: row.scopeHash,
    status: row.status as SpendProposalStatus,
    proposedBy: row.proposedBy,
    proposedAt: row.proposedAt,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
  };
}

function toApproval(row: {
  id: string;
  workspaceId: string;
  proposalId: string;
  approver: string;
  decidedAt: Date;
  scopeHash: string;
}): SpendApproval {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    proposalId: row.proposalId,
    approver: row.approver,
    decidedAt: row.decidedAt,
    scopeHash: row.scopeHash,
  };
}

export function prismaProposalStore(): SpendProposalStore {
  return {
    async create(input) {
      const row = await prisma.spendProposal.create({
        data: {
          workspaceId: input.workspaceId,
          kind: input.kind,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          payload: input.payload as Prisma.InputJsonValue,
          scopeHash: input.scopeHash,
          proposedBy: input.proposedBy,
          expiresAt: input.expiresAt,
        },
      });
      return toProposal(row);
    },
    async get(id) {
      const row = await prisma.spendProposal.findFirst({ where: { id } });
      return row ? toProposal(row) : null;
    },
    async setStatus(id, status, decidedBy) {
      const row = await prisma.spendProposal.update({
        where: { id },
        data: {
          status,
          decidedBy: decidedBy ?? null,
          decidedAt: decidedBy ? new Date() : null,
        },
      });
      return toProposal(row);
    },
  };
}

export function prismaApprovalStore(): SpendApprovalStore {
  return {
    async create(input) {
      const row = await prisma.spendApproval.create({
        data: {
          workspaceId: input.workspaceId,
          proposalId: input.proposalId,
          approver: input.approver,
          scopeHash: input.scopeHash,
        },
      });
      return toApproval(row);
    },
    async getByProposalId(proposalId) {
      const row = await prisma.spendApproval.findUnique({ where: { proposalId } });
      return row ? toApproval(row) : null;
    },
  };
}
