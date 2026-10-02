// Marketr — Connector Agent slice 6 API: the Boardy escalation rail.
// boardy.ai/agentskill is an instruction page for an EMAIL flow, not a
// programmatic API (verified 2026-09-30): the rail drafts the request email,
// the tenant approves per instance (human-only), it sends from the tenant's
// own address to boardy@boardy.ai, and Boardy's reply is triaged as a
// priority thread. The native loop never blocks on this rail.
//
// GET  /api/connector/boardy — list the tenant's requests (viewer role).
// POST /api/connector/boardy — draft a request (editor role). Auto-draft
//   ONLY: nothing sends from here. { targetName, targetRole, targetContext,
//   offerSummary, mode?, tenantName, draftedSubject?, draftedBody? }
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaBoardyRailStore } from "@/lib/connector/boardy-rail";
import { ConnectorError } from "@/lib/connector/types";
import { introErrorResponse } from "../intros/intro-error";

export const dynamic = "force-dynamic";

function store() {
  return new PrismaBoardyRailStore(prisma);
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const requests = await store().listBoardyRequests(workspace.id);
    return Response.json({ requests });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as Record<string, unknown>;
    const request = await store().draftBoardyRequest(
      workspace.id,
      {
        targetName: body.targetName,
        targetRole: body.targetRole,
        targetContext: body.targetContext,
        offerSummary: body.offerSummary,
        mode: body.mode,
        tenantName: body.tenantName,
        draftedSubject: body.draftedSubject,
        draftedBody: body.draftedBody,
      },
      { draftedBy: { kind: "human", identity: user.email ?? user.id } },
    );
    return Response.json({ request });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}
