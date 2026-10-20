// ShapesOS — Phase 18.3 (WS=trust): forget one memory.
//   DELETE /api/trust/memory/[store]/[id]?scope=me|workspace → { ok: true }
// scope=me (viewer+): only a memory from the caller's own work.
// scope=workspace (admin+): any memory in the workspace.
// A real delete under RLS (embeddings live in the row); audited without the text.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { roleAtLeast } from "@/lib/authz";
import { forgetMemory, isMemoryStore } from "@/lib/privacy/memory";
import { NO_STORE, trustGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ store: string; id: string }> }) {
  const ctx = await trustGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const { store, id } = await params;
    if (!isMemoryStore(store)) return Response.json({ error: "Unknown memory kind." }, { status: 400 });
    const workspaceWide = req.nextUrl.searchParams.get("scope") === "workspace";
    if (workspaceWide && !roleAtLeast(ctx.role, "admin")) return Response.json({ error: "This needs the admin role." }, { status: 403 });
    await forgetMemory({ workspaceId: ctx.workspaceId, store, id: String(id).slice(0, 64), actorUserId: ctx.userId, forUserId: workspaceWide ? null : ctx.userId });
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "DELETE /api/trust/memory/[store]/[id]");
  }
}
