// ShapesOS — Phase 18.2 (WS=comms): the contact card of a record.
//   GET /api/comms/contacts/resolve?kind=lead&id=… → { identityId }   (viewer+)
// Lets any app ("Open contact card" on a lead, a ticket requester…) land on
// the person's one card; links the record on the fly if the sync has not yet.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { identityForRecord } from "@/lib/comms/contacts/store";
import { isContactRecordKind } from "@/lib/comms/contacts/match";
import { commsGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ctx = await commsGuard("viewer");
    const kind = req.nextUrl.searchParams.get("kind");
    const id = (req.nextUrl.searchParams.get("id") ?? "").slice(0, 64);
    if (!isContactRecordKind(kind) || !id) return Response.json({ error: "kind and id are required." }, { status: 400 });
    const identityId = await withWorkspaceScope(ctx.workspaceId, (tx) => identityForRecord(tx, ctx.workspaceId, kind, id));
    return Response.json({ identityId });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/contacts/resolve");
  }
}
