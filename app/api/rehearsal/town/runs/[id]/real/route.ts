// ShapesOS — Phase 19B (WS=engine): "do this for real".
// POST /api/rehearsal/town/runs/:id/real { variant: "A"|"B", index, confirmed? } → RealProposal
// A normal proposal through executeTool (lib/sim/real.server.ts): Tier 2 for a
// launch change, Tier 3 (always asks) for an ad campaign; `confirmed: true`
// is the person's explicit OK. Editor+.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { townActor } from "@/lib/sim/http.server";
import { proposeForReal } from "@/lib/sim/real.server";

export const dynamic = "force-dynamic";

const Body = z.object({ variant: z.enum(["A", "B"]), index: z.number().int().min(0).max(50), confirmed: z.boolean().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace();
    const { id } = await params;
    const body = Body.parse(await readJson(req));
    return Response.json(await proposeForReal(await townActor(user.id, workspace.id), id, body));
  } catch (e) {
    return httpErrorResponse(e);
  }
}
