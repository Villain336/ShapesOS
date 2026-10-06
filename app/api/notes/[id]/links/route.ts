// ShapesOS — Phase 18.2 (WS=content): a note's record links.
// POST   /api/notes/[id]/links { kind, id, label? }   → { note } (idempotent)
// DELETE /api/notes/[id]/links?kind=&id=              → { note }
// kind is a Spotlight record kind (lib/search/kinds.ts). Linking changes the
// note: guardWorkspace + edit rights on the note (lib/notes/service.ts).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { linkNote, unlinkNote } from "@/lib/notes/service";
import { noteActor } from "@/lib/notes/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const LinkSchema = z.object({ kind: z.string().max(40), id: z.string().max(64), label: z.string().max(200).nullish() });

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const { id } = await ctx.params;
    const link = LinkSchema.parse(await readJson(req));
    const note = await linkNote(actor, id, link);
    return Response.json({ note });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const { id } = await ctx.params;
    const kind = req.nextUrl.searchParams.get("kind") ?? "";
    const recordId = req.nextUrl.searchParams.get("id") ?? "";
    const note = await unlinkNote(actor, id, kind, recordId);
    return Response.json({ note });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
