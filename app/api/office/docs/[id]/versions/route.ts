// ShapesOS — Phase 18.2 (WS=content): an Office doc's version history.
// GET  /api/office/docs/[id]/versions          → { versions } (viewer+)
// POST /api/office/docs/[id]/versions { name } → 201 { version } (editor+: a named version)
// Idle snapshots are taken on save (lib/univer/docs.ts → lib/univer/versions.ts).

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { getUniverDoc } from "@/lib/univer/docs";
import { listDocVersions, saveNamedVersion } from "@/lib/univer/versions";
import { NotFoundError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    if (!(await getUniverDoc(workspace.id, id))) throw new NotFoundError("Document not found.");
    return Response.json({ versions: await listDocVersions(workspace.id, id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    if (!(await getUniverDoc(workspace.id, id))) throw new NotFoundError("Document not found.");
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(await readJson(req));
    return Response.json({ version: await saveNamedVersion(workspace.id, id, name, user.id) }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
