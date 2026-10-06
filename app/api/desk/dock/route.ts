// ShapesOS — Phase 18.1 (WS=desk): the caller's dock — pins over lib/nav/config.ts + recents.
//   GET /api/desk/dock              → { pinned: string[], recents: RecentItem[] }
//   PUT /api/desk/dock { pinned }   → { pinned }  (unknown hrefs and role-gated items dropped)
// viewer+ (the caller's own dock; owner-only RLS). The nav list itself is never stored.

import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { getDesk, listRecents, saveNav } from "@/lib/desktop/store.server";
import { deskGuard, NO_STORE } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const [desk, recents] = await Promise.all([getDesk(ctx.workspaceId, ctx.userId, ctx.role), listRecents(ctx.workspaceId, ctx.userId)]);
    return Response.json({ pinned: desk.nav.pinned, recents }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/desk/dock");
  }
}

const PutSchema = z.object({ pinned: z.array(z.string().max(200)).max(48) });

export async function PUT(req: Request) {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const body = validateBody(PutSchema, await req.json());
    if (!body.ok) return body.error;
    const nav = await saveNav(ctx.workspaceId, ctx.userId, ctx.role, { pinned: body.data.pinned });
    return Response.json({ pinned: nav.pinned }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "PUT /api/desk/dock");
  }
}
