// Marketr — CAD + Hardware slice 2 API.
// GET  /api/cad/models/[id]/proposals — the approval queue (viewer+; ?status= draft|approved|rejected).
// POST /api/cad/models/[id]/proposals — draft a proposal from natural language (editor).
//        The request is PARSED, never executed: it enters the queue as a draft.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadAiStore } from "@/lib/cad/ai-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["MODEL_NOT_FOUND", "VERSION_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadAiStore(prisma);
    const url = new URL(req.url);
    const proposals = await store.listProposals(
      workspace.id,
      id,
      url.searchParams.get("status") ?? undefined,
    );
    return Response.json({ proposals });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadAiStore(prisma);
    const { proposal, parse } = await store.createProposal(
      workspace.id,
      user.email ?? user.id,
      id,
      body?.targetVersionId ?? "",
      body?.requestedText ?? "",
      body?.targetRegion ?? null,
    );
    return Response.json({ proposal, parse }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
