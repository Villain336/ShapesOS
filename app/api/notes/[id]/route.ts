// ShapesOS — Phase 18.2 (WS=content): one note.
// GET    /api/notes/[id]            → { note } (404 when not visible to you)
// PATCH  /api/notes/[id] { title?, content?, expectedVersion?, pinned?, folder?, tags?, shareState? }
//          → { note }; 409 when expectedVersion is stale
// DELETE /api/notes/[id]            → { ok: true } (the maker, or admin+ on a shared note)
// Access: guardWorkspace (signed in, current workspace) + the note's own
// rules in lib/notes/service.ts (private = its maker only).

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { deleteNote, getNote, updateNote } from "@/lib/notes/service";
import { noteActor } from "@/lib/notes/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  title: z.string().max(200).nullish(),
  content: z.unknown().optional(),
  expectedVersion: z.number().int().min(0).optional(),
  pinned: z.boolean().optional(),
  folder: z.string().max(120).nullish(),
  tags: z.array(z.string().max(60)).max(20).optional(),
  shareState: z.enum(["private", "workspace"]).optional(),
});

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const { id } = await ctx.params;
    const note = await getNote(actor, id);
    if (!note) return Response.json({ error: "Note not found." }, { status: 404 });
    return Response.json({ note }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const { id } = await ctx.params;
    const body = PatchSchema.parse(await readJson(req));
    const note = await updateNote(actor, id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      ...(body.folder !== undefined ? { folder: body.folder } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.shareState !== undefined ? { shareState: body.shareState } : {}),
    });
    return Response.json({ note });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const { id } = await ctx.params;
    await deleteNote(actor, id);
    return Response.json({ ok: true });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
