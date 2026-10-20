// Marketr — Phase 14: single Office doc API.
// GET    /api/office/docs/[id]
// PATCH  /api/office/docs/[id] { snapshot?, title? , expectedVersion? }
// DELETE /api/office/docs/[id]

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import {
  deleteUniverDoc,
  getUniverDoc,
  renameUniverDoc,
  saveUniverDocSnapshot,
} from "@/lib/univer/docs";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  snapshot: z.unknown().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

function conflict(e: unknown): Response | null {
  if (e instanceof Error && e.message.startsWith("version conflict")) {
    return Response.json({ error: e.message }, { status: 409 });
  }
  if (e instanceof Error && e.message === "doc not found") {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const doc = await getUniverDoc(workspace.id, id);
    if (!doc) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ doc });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const body = PatchSchema.parse(await readJson(req));
    let doc = await getUniverDoc(workspace.id, id);
    if (!doc) return Response.json({ error: "not found" }, { status: 404 });
    if (body.title !== undefined) {
      doc = await renameUniverDoc(workspace.id, id, body.title);
    }
    if (body.snapshot !== undefined) {
      try {
        doc = await saveUniverDocSnapshot(workspace.id, id, body.snapshot, {
          // Phase 18.2: who saved (the idle snapshot it may keep is theirs).
          userId: user.id,
          ...(body.expectedVersion !== undefined
            ? { expectedVersion: body.expectedVersion }
            : {}),
        });
      } catch (e) {
        const mapped = conflict(e);
        if (mapped) return mapped;
        throw e;
      }
    }
    return Response.json({ doc });
  } catch (e) {
    const mapped = conflict(e);
    if (mapped) return mapped;
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    try {
      await deleteUniverDoc(workspace.id, id);
    } catch (e) {
      const mapped = conflict(e);
      if (mapped) return mapped;
      throw e;
    }
    return Response.json({ ok: true });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
