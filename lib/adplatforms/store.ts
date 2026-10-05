// Marketr — Phase 18 slice 1: Prisma-backed gate ports.
//
// Production implementations of the SpendProposalStore / SpendApprovalStore
// ports from ./gate.ts. SpendApproval rows are insert-only by construction —
// this module exposes no update or delete.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AdsGateError } from "./gate";
import type {
  SpendApproval,
  SpendApprovalStore,
  SpendProposal,
  SpendProposalKind,
  SpendProposalStatus,
  SpendProposalStore,
} from "./gate";
import { notifyApprovalDecided, notifyApprovalNeeded } from "@/lib/notifications/producers";

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
      // Phase 3 (J): best-effort "needs you" notification (never throws).
      await notifyApprovalNeeded({
        workspaceId: row.workspaceId,
        source: "spend",
        sourceId: row.id,
        title: `${row.action.replace(/_/g, " ")} ${row.targetType}`,
        href: "/dashboard/media/advertising/proposals?status=pending",
        requestedBy: row.proposedBy,
      });
      return toProposal(row);
    },
    // spend_proposals has no RLS: every read and write carries workspaceId.
    async get(id, workspaceId) {
      const row = await prisma.spendProposal.findFirst({ where: { id, workspaceId } });
      return row ? toProposal(row) : null;
    },
    async setStatus(id, workspaceId, status, decidedBy) {
      const { count } = await prisma.spendProposal.updateMany({
        where: { id, workspaceId },
        data: {
          status,
          decidedBy: decidedBy ?? null,
          decidedAt: decidedBy ? new Date() : null,
        },
      });
      const row = count === 1 ? await prisma.spendProposal.findFirst({ where: { id, workspaceId } }) : null;
      if (!row) throw new AdsGateError("PROPOSAL_NOT_FOUND", `Proposal ${id} not found`);
      if (decidedBy && (status === "approved" || status === "rejected")) {
        await notifyApprovalDecided({
          workspaceId,
          source: "spend",
          sourceId: row.id,
          title: `${row.action.replace(/_/g, " ")} ${row.targetType}`,
          decision: status === "approved" ? "approved" : "denied",
          decidedBy,
          requestedBy: row.proposedBy,
          href: "/dashboard/media/advertising/proposals",
        });
      }
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
    async getByProposalId(proposalId, workspaceId) {
      const row = await prisma.spendApproval.findFirst({ where: { proposalId, workspaceId } });
      return row ? toApproval(row) : null;
    },
  };
}
