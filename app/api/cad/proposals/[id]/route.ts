// Marketr — CAD + Hardware slice 2 API.
// GET   /api/cad/proposals/[id] — proposal detail (viewer+).
// PATCH /api/cad/proposals/[id] — fix the parsed fields while a draft (editor).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadAiStore } from "@/lib/cad/ai-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["PROPOSAL_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadAiStore(prisma);
    const proposal = await store.getProposal(workspace.id, id);
    return Response.json({ proposal });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadAiStore(prisma);
    const proposal = await store.updateProposalDraft(workspace.id, id, {
      operation: body?.operation,
      parameters: body?.parameters,
      targetFeatureLabel: body?.targetFeatureLabel,
      rationale: body?.rationale,
    });
    return Response.json({ proposal });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
