// ShapesOS — Phase 18.2 (WS=content): one version of an Office doc.
// GET  …/versions/[versionId] → { version, text } (viewer+: a text preview)
// POST …/versions/[versionId] → { version } (editor+: RESTORE — the current state is kept
//        as a "restore" version and the chosen snapshot becomes a new version)

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { getUniverDoc } from "@/lib/univer/docs";
import { getDocVersion, restoreDocVersion } from "@/lib/univer/versions";
import { auditEvent } from "@/lib/auditlog";
import { NotFoundError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; versionId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { workspace } = await guardWorkspace();
    const { id, versionId } = await ctx.params;
    const doc = await getUniverDoc(workspace.id, id);
    if (!doc) throw new NotFoundError("Document not found.");
    const v = await getDocVersion(workspace.id, id, versionId);
    if (!v) throw new NotFoundError("Version not found.");
    const { snapshot, ...meta } = v;
    // Lazy: the indexer never ships in a route bundle (bundle-size rule).
    const { extractUniverText } = await import("@/lib/search/text-index");
    const text = await extractUniverText(doc.kind, snapshot);
    return Response.json({ version: meta, text: text.text.slice(0, 20_000) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id, versionId } = await ctx.params;
    const doc = await getUniverDoc(workspace.id, id);
    if (!doc) throw new NotFoundError("Document not found.");
    const res = await restoreDocVersion(workspace.id, id, versionId, user.id);
    await auditEvent({
      workspaceId: workspace.id,
      projectId: null,
      action: "doc_version_restored",
      summary: `Doc "${doc.title.slice(0, 120)}" restored to a version from ${res.restoredFrom.createdAt.slice(0, 16).replace("T", " ")}`,
      actorUserId: user.id,
    });
    return Response.json({ version: res.version, restoredFrom: res.restoredFrom });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
