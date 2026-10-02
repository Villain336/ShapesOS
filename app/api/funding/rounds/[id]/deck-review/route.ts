// Marketr — Funding/VC slice 4 API.
// GET  /api/funding/rounds/[id]/deck-review — latest deterministic review.
// POST /api/funding/rounds/[id]/deck-review — run the deterministic rubric
//        (editor) against the latest pitch-deck version. Optional body:
//        { deckText } — founder-supplied deck copy for the text-driven
//        checks; without it those criteria are "not_detected", never guessed.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const store = new PrismaFundingStore(prisma);
    const review = await store.getLatestDeckReview(workspace.id, id);
    return Response.json({ workspaceId: workspace.id, roundId: id, review });
  } catch (e) {
    if (e instanceof FundingError) {
      return Response.json(
        { error: e.message, code: e.code },
        { status: e.code === "ROUND_NOT_FOUND" ? 404 : 400 },
      );
    }
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as { deckText?: unknown };
    const store = new PrismaFundingStore(prisma);
    const review = await store.runDeckReview(workspace.id, id, body);
    return Response.json({ workspaceId: workspace.id, roundId: id, review }, { status: 201 });
  } catch (e) {
    if (e instanceof FundingError) {
      return Response.json(
        { error: e.message, code: e.code },
        { status: e.code === "ROUND_NOT_FOUND" ? 404 : 400 },
      );
    }
    return httpErrorResponse(e);
  }
}
