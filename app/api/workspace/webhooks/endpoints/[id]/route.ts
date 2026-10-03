// ShapesOS — one outbound webhook endpoint (Phase 4a). Admin+ only.
// PATCH  /api/workspace/webhooks/endpoints/[id] { url?, description?, events?, enabled?, rotateSecret? }
//          → { endpoint, secret }  (secret is non-null only after a rotation, shown ONCE)
// DELETE /api/workspace/webhooks/endpoints/[id] → { ok: true } (its delivery log goes with it)

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { deleteEndpoint, updateEndpoint } from "@/lib/webhooks/endpoints";
import { webhookAdmin } from "../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const ctx = await webhookAdmin();
    const { id } = await params;
    const body = await req.json();
    return Response.json(await updateEndpoint(ctx.workspaceId, id, body));
  } catch (err) {
    return errorResponse(err, "PATCH /api/workspace/webhooks/endpoints/[id]");
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const ctx = await webhookAdmin();
    const { id } = await params;
    await deleteEndpoint(ctx.workspaceId, id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "DELETE /api/workspace/webhooks/endpoints/[id]");
  }
}
