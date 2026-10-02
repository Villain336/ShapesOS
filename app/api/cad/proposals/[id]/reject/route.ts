// Marketr — CAD + Hardware slice 2 API.
// POST /api/cad/proposals/[id]/reject — reject a draft proposal (editor).
//        Human-only (the store rejects agent actors). The model is untouched.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadAiStore } from "@/lib/cad/ai-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["PROPOSAL_NOT_FOUND"];
  const forbidden = ["AGENT_CANNOT_ACT"];
  const status = notFound.includes(e.code)
    ? 404
    : forbidden.includes(e.code)
      ? 403
      : 400;
  return Response.json({ error: e.message, code: e.code }, { status });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json().catch(() => ({}));
    const store = new PrismaCadAiStore(prisma);
    const proposal = await store.rejectProposal(
      workspace.id,
      { kind: "human", identity: user.email ?? user.id },
      id,
      body?.note ?? null,
    );
    return Response.json({ proposal });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
