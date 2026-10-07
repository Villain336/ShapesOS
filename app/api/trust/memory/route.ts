// ShapesOS — Phase 18.3 (WS=trust): memory controls — see what agents remember.
//   GET /api/trust/memory?scope=me|workspace&store=episode|fact|learning|knowledge&before=
//     → { items: MemoryItem[] }
// scope=me (viewer+): memories from the caller's own work.
// scope=workspace (admin+): every memory in the workspace.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { roleAtLeast } from "@/lib/authz";
import { isMemoryStore, listMemory } from "@/lib/privacy/memory";
import { NO_STORE, trustGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ctx = await trustGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const q = req.nextUrl.searchParams;
    const workspaceWide = q.get("scope") === "workspace";
    if (workspaceWide && !roleAtLeast(ctx.role, "admin")) return Response.json({ error: "This needs the admin role." }, { status: 403 });
    const store = q.get("store") ?? "episode";
    if (!isMemoryStore(store)) return Response.json({ error: "Unknown memory kind." }, { status: 400 });
    const before = q.get("before") ? new Date(q.get("before")!) : null;
    const items = await listMemory({
      workspaceId: ctx.workspaceId,
      store,
      forUserId: workspaceWide ? null : ctx.userId,
      before: before && !Number.isNaN(before.getTime()) ? before : null,
    });
    return Response.json({ items }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/trust/memory");
  }
}
