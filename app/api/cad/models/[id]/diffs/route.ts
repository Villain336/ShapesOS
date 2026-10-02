// Marketr — CAD + Hardware slice 1 API.
// GET  /api/cad/models/[id]/diffs — recorded diff rows (viewer+).
// POST /api/cad/models/[id]/diffs — compute + record the diff between two
//        versions: { fromVersionId, toVersionId } (editor). Idempotent per
//        pair. A diff between parseable revisions is "computed"; any side
//        without real geometry stats (e.g. STEP) records "unavailable" —
//        the numbers are never invented.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadStore } from "@/lib/cad/prisma-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function cadErrorResponse(e: CadError) {
  const notFound = ["MODEL_NOT_FOUND", "VERSION_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadStore(prisma);
    const { diffs } = await store.getModelDetail(workspace.id, id);
    return Response.json({ diffs });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      fromVersionId?: unknown;
      toVersionId?: unknown;
    };
    const fromVersionId = typeof body.fromVersionId === "string" ? body.fromVersionId : "";
    const toVersionId = typeof body.toVersionId === "string" ? body.toVersionId : "";
    if (!fromVersionId || !toVersionId) {
      throw new CadError("INVALID_DIFF", "fromVersionId and toVersionId are required.");
    }
    const store = new PrismaCadStore(prisma);
    const diff = await store.recordDiff(workspace.id, id, fromVersionId, toVersionId);
    return Response.json({ diff }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
