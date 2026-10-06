// ShapesOS — Phase 18.2 (WS=content): one version of a note.
// GET  /api/notes/[id]/versions/[versionId] → { version, content, text } (preview; read rights)
// POST /api/notes/[id]/versions/[versionId] → { version: <new doc version> } — RESTORE: the
//        current state is kept as a "restore" version, the chosen one is written back as a
//        new version, and live editors reload (edit rights).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { noteAccess } from "@/lib/notes/service";
import { noteActor } from "@/lib/notes/http";
import { noteText } from "@/lib/notes/content";
import { getDocVersion, restoreDocVersion } from "@/lib/univer/versions";
import { auditEvent } from "@/lib/auditlog";
import { ForbiddenError, NotFoundError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; versionId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const { id, versionId } = await ctx.params;
    if (!(await noteAccess(actor, id))) throw new NotFoundError("Note not found.");
    const v = await getDocVersion(workspace.id, id, versionId);
    if (!v) throw new NotFoundError("Version not found.");
    const { snapshot, ...meta } = v;
    return Response.json({ version: meta, content: snapshot, text: noteText(snapshot, 20_000) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const { id, versionId } = await ctx.params;
    const access = await noteAccess(actor, id);
    if (!access) throw new NotFoundError("Note not found.");
    if (!access.canEdit) throw new ForbiddenError("You can read this note but not change it.");
    const res = await restoreDocVersion(workspace.id, id, versionId, user.id);
    await auditEvent({
      workspaceId: workspace.id,
      projectId: null,
      action: "doc_version_restored",
      summary: `Note "${access.title.slice(0, 120)}" restored to a version from ${res.restoredFrom.createdAt.slice(0, 16).replace("T", " ")}`,
      actorUserId: user.id,
    });
    return Response.json({ version: res.version, restoredFrom: res.restoredFrom });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
