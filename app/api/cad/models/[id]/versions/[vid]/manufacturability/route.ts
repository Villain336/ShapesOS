// Marketr — CAD + Hardware slice 2 API.
// GET  /api/cad/models/[id]/versions/[vid]/manufacturability — runs + flags (viewer+; ?versionId= is the [vid] path).
// POST /api/cad/models/[id]/versions/[vid]/manufacturability — run the analysis (editor).
//        STEP versions record an "unavailable" run — analysis is never invented.

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
  _req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> },
) {
  try {
    const { id, vid } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadAiStore(prisma);
    const [runs, flags] = await Promise.all([
      store.listMfgRuns(workspace.id, id, vid),
      store.listMfgFlags(workspace.id, id, vid),
    ]);
    return Response.json({ runs, flags });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> },
) {
  try {
    const { id, vid } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaCadAiStore(prisma);
    const { run, flags } = await store.runManufacturability(
      workspace.id,
      user.email ?? user.id,
      id,
      vid,
    );
    return Response.json({ run, flags }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
