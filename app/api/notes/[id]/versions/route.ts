// ShapesOS — Phase 18.2 (WS=content): a note's version history.
// GET  /api/notes/[id]/versions          → { versions: DocVersionMeta[] } (anyone who can read the note)
// POST /api/notes/[id]/versions { name } → 201 { version } (a named version; edit rights)
// Snapshots on idle are taken automatically (lib/univer/versions.ts).

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { noteAccess } from "@/lib/notes/service";
import { noteActor } from "@/lib/notes/http";
import { listDocVersions, saveNamedVersion } from "@/lib/univer/versions";
import { ForbiddenError, NotFoundError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const { id } = await ctx.params;
    if (!(await noteAccess(actor, id))) throw new NotFoundError("Note not found.");
    return Response.json({ versions: await listDocVersions(workspace.id, id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const { id } = await ctx.params;
    const access = await noteAccess(actor, id);
    if (!access) throw new NotFoundError("Note not found.");
    if (!access.canEdit) throw new ForbiddenError("You can read this note but not change it.");
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(await readJson(req));
    const version = await saveNamedVersion(workspace.id, id, name, user.id);
    return Response.json({ version }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
