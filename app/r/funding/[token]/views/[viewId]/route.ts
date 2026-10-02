// Marketr — Funding/VC slice 3: duration beacon for share-link views.
// POST /r/funding/[token]/views/[viewId] — { durationMs } — how long the
//        viewer kept the document open. Optional; the view row already
//        exists from the page load.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string; viewId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { token, viewId } = await params;
    const store = new PrismaFundingStore(prisma);
    const link = await store.getShareLinkByToken(token);
    if (!link || link.revoked) {
      return Response.json({ error: "Link unavailable." }, { status: 404 });
    }
    // The beacon only touches a view row inside this link's workspace.
    const view = await prisma.fundingDocView.findFirst({
      where: { id: viewId, linkId: link.id, workspaceId: link.workspaceId },
      select: { id: true },
    });
    if (!view) {
      return Response.json({ error: "View not found." }, { status: 404 });
    }
    let durationMs: unknown = null;
    try {
      const body = (await req.json()) as { durationMs?: unknown };
      durationMs = body.durationMs;
    } catch {
      durationMs = null;
    }
    if (typeof durationMs !== "number") {
      return Response.json({ error: "durationMs must be a number." }, { status: 400 });
    }
    await store.updateViewDuration(link.workspaceId, viewId, Math.round(durationMs));
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof FundingError) {
      return Response.json(
        { error: e.message, code: e.code },
        { status: e.code === "VIEW_NOT_FOUND" ? 404 : 400 },
      );
    }
    return Response.json({ error: "Could not record view duration." }, { status: 500 });
  }
}
