// ShapesOS — Phase 18.1 (WS=desk): the caller's desktop layout (Home widgets).
//   GET    /api/desk/layout            → { layout, customized }
//   PUT    /api/desk/layout { layout } → { layout }  (400 with issues when invalid)
//   DELETE /api/desk/layout            → { layout }  (back to the role default)
// viewer+ (the caller's own desk; owner-only RLS). Validation: lib/desktop/layout.ts.

import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { getDesk, LayoutRejected, resetLayout, saveLayout } from "@/lib/desktop/store.server";
import { deskGuard, NO_STORE } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const desk = await getDesk(ctx.workspaceId, ctx.userId, ctx.role);
    return Response.json({ layout: desk.layout, customized: desk.customized }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/desk/layout");
  }
}

const PutSchema = z.object({ layout: z.unknown() });

export async function PUT(req: Request) {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const body = validateBody(PutSchema, await req.json());
    if (!body.ok) return body.error;
    const layout = await saveLayout(ctx.workspaceId, ctx.userId, ctx.role, body.data.layout);
    return Response.json({ layout }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof LayoutRejected) {
      return Response.json({ error: err.message, issues: err.issues }, { status: 400 });
    }
    return errorResponse(err, "PUT /api/desk/layout");
  }
}

export async function DELETE() {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const layout = await resetLayout(ctx.workspaceId, ctx.userId, ctx.role);
    return Response.json({ layout }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "DELETE /api/desk/layout");
  }
}
