// Marketr — POST /api/flywheel/reallocation/proposals/:id/approve
//
// Mode (a): the human approves a proposed shift. Approving materializes a
// standard Phase 5 per-buy approval object (binding hash covers the exact
// source→dest campaign refs and amount); the approver's decision is recorded
// on that object via the Phase 5 approval flow, including the two-person
// rule. Owner/admin only — buyers propose but never approve.

import type { NextRequest } from "next/server";
import {
  flywheelGuard, badRequest, safetyError, readJson, requireOwner,
  getStore, reallocationTablesReady, tablesNotReady,
} from "../../../_lib";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import {
  approveApproval,
  submitApproval,
} from "@/lib/media/approvals";
import { materializeModeAApproval } from "@/lib/flywheel/reallocation/checkout";
import { AuditLog } from "@/lib/flywheel/reallocation/audit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  const owner = requireOwner(gate);
  if (owner) return owner;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  if (!(await safetyTablesReady())) {
    return Response.json(
      { error: "Media safety tables not provisioned yet (fragment not merged/migrated)." },
      { status: 503 },
    );
  }
  const { id } = await ctx.params;
  const body = await readJson(req);
  const clientAdAccountId = body.clientAdAccountId as string | undefined;
  const platform = body.platform as string | undefined;
  if (!clientAdAccountId?.trim()) return badRequest("clientAdAccountId is required (zero custody: the client's own ad account)");
  if (!platform?.trim()) return badRequest("platform is required");

  try {
    const store = getStore();
    const proposal = await store.getProposal(id, gate.workspaceId);
    if (!proposal) return Response.json({ error: "Proposal not found in workspace" }, { status: 404 });
    if (proposal.mode !== "a") return badRequest("Only mode-(a) proposals go through human approval here");
    if (proposal.status !== "proposed") {
      return badRequest(`Proposal status is "${proposal.status}" — only "proposed" can be approved`);
    }

    const { approvals } = mediaStores();
    const created = await materializeModeAApproval(approvals, {
      proposal,
      clientAdAccountId: clientAdAccountId.trim(),
      platform: platform.trim(),
      createdBy: "f1-optimizer", // system proposed the terms; the human approves (separation of duties)
      currency: (body.currency as string | undefined) ?? "USD",
    });
    const submitted = await submitApproval(approvals, created.id, gate.workspaceId, gate.userId);
    const decided = await approveApproval(approvals, {
      id: submitted.id,
      workspaceId: gate.workspaceId,
      approverId: gate.userId,
      approverMediaRole: "owner",
      method: "sso",
      twoPersonThresholdCents: 100_000,
    });

    const audit = new AuditLog(store.audit);
    if (decided.status === "approved") {
      const updated = await store.updateProposal(id, gate.workspaceId, {
        status: "human_approved",
        humanApprovalId: decided.id,
      });
      await audit.append(gate.workspaceId, "approval_materialized", gate.userId, {
        proposalId: id, approvalId: decided.id, bindingHash: decided.bindingHash,
        amountCents: proposal.amountCents,
      });
      await audit.append(gate.workspaceId, "proposal_status", gate.userId, {
        proposalId: id, from: "proposed", to: "human_approved",
      });
      return Response.json({ proposal: updated, approval: { id: decided.id, status: decided.status, bindingHash: decided.bindingHash } });
    }
    // Two-person short count: decision recorded, approval stays pending.
    await audit.append(gate.workspaceId, "approval_materialized", gate.userId, {
      proposalId: id, approvalId: decided.id, pendingSecondApprover: true,
    });
    return Response.json({
      proposal,
      approval: { id: decided.id, status: decided.status },
      pendingSecondApprover: true,
      note: "First of two required decisions recorded — a second human approver must decide before execution.",
    });
  } catch (err) {
    return safetyError(err);
  }
}
