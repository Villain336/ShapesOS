// Marketr — CAD + Hardware slice 1 API.
// POST   /api/cad/share-links/[id]/revoke — revoke a link (editor,
//          idempotent). Revoked links 404 on the public surface.
// DELETE /api/cad/share-links/[id] — delete a link row (editor).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadStore } from "@/lib/cad/prisma-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function cadErrorResponse(e: CadError) {
  return Response.json(
    { error: e.message, code: e.code },
    { status: e.code === "LINK_NOT_FOUND" ? 404 : 400 },
  );
}

export async function POST(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaCadStore(prisma);
    const link = await store.revokeShareLink(workspace.id, id);
    const { token: _t, ...safe } = link;
    return Response.json({ link: safe });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaCadStore(prisma);
    await store.deleteShareLink(workspace.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
