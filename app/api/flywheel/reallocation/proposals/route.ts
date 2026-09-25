// Marketr — POST /api/flywheel/reallocation/proposals (optimizer output → stored)
//          GET  /api/flywheel/reallocation/proposals (list)

import type { NextRequest } from "next/server";
import {
  flywheelGuard, badRequest, safetyError, readJson,
  getStore, reallocationTablesReady, tablesNotReady,
} from "../_lib";
import { AuditLog } from "@/lib/flywheel/reallocation/audit";
import type { DecisionRecord, ReallocationMode } from "@/lib/flywheel/reallocation/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await flywheelGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  const store = getStore();
  const proposals = await store.listProposals(gate.workspaceId, 100);
  return Response.json({ proposals });
}

export async function POST(req: NextRequest) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  const body = await readJson(req);

  const mode = body.mode as ReallocationMode;
  if (mode !== "a" && mode !== "b") return badRequest("mode must be 'a' or 'b'");
  const amountCents = body.amountCents as number;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return badRequest("amountCents must be a positive integer");
  }
  for (const f of ["sourceChannel", "destChannel", "sourceCampaignRef", "destCampaignRef"]) {
    if (typeof body[f] !== "string" || !(body[f] as string).trim()) return badRequest(`${f} is required`);
  }
  const decisionRecord = body.decisionRecord as DecisionRecord | undefined;
  if (!decisionRecord || typeof decisionRecord.marginalRoasDelta !== "number") {
    return badRequest("decisionRecord with marginal-ROAS fields is required — proposals without a decision record are not audit answers");
  }

  try {
    const store = getStore();
    if (mode === "b") {
      if (typeof body.sraId !== "string" || !body.sraId) return badRequest("mode 'b' requires sraId");
      const sra = await store.getSra(body.sraId as string, gate.workspaceId);
      if (!sra) return badRequest("SRA not found in workspace");
    }
    const proposal = await store.createProposal({
      workspaceId: gate.workspaceId,
      mode,
      sraId: (body.sraId as string) ?? null,
      sourceChannel: body.sourceChannel as string,
      destChannel: body.destChannel as string,
      sourceCampaignRef: body.sourceCampaignRef as string,
      destCampaignRef: body.destCampaignRef as string,
      amountCents,
      marginalRoasDelta: decisionRecord.marginalRoasDelta,
      decisionRecord,
      status: "proposed",
      humanApprovalId: null,
      createdAt: new Date().toISOString(),
    });
    const audit = new AuditLog(store.audit);
    await audit.append(gate.workspaceId, "proposal_created", gate.userId, {
      proposalId: proposal.id, mode, amountCents,
      sourceChannel: proposal.sourceChannel, destChannel: proposal.destChannel,
    });
    return Response.json({ proposal }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}
