// ShapesOS — Phase 18.2 (WS=comms): merge suggestions.
//   GET /api/comms/contacts/suggestions[?status=pending|confirmed|rejected] → { items, total }   (viewer+)

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listSuggestions } from "@/lib/comms/contacts/store";
import { ensureFreshContacts } from "@/lib/comms/contacts/sync.server";
import { commsGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ctx = await commsGuard("viewer");
    const raw = req.nextUrl.searchParams.get("status");
    const status = raw === "confirmed" || raw === "rejected" ? raw : "pending";
    if (status === "pending") await ensureFreshContacts(ctx.workspaceId);
    const out = await withWorkspaceScope(ctx.workspaceId, (tx) => listSuggestions(tx, { workspaceId: ctx.workspaceId, status, limit: 100 }));
    return Response.json(out);
  } catch (err) {
    return errorResponse(err, "GET /api/comms/contacts/suggestions");
  }
}
