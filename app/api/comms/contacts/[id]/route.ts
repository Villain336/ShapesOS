// ShapesOS — Phase 18.2 (WS=comms): one person in the address book.
//   GET /api/comms/contacts/[id] → { identity, records, timeline, suggestions }   (viewer+)
// Every linked record (with a deep link into its own app), the timeline
// across them (mail, texts, meetings, calls, deals, tickets, invoices,
// funding) and the pending merge suggestions about them.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getIdentityDetail } from "@/lib/comms/contacts/store";
import { commsGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await commsGuard("viewer");
    const { id } = await params;
    const detail = await withWorkspaceScope(ctx.workspaceId, (tx) => getIdentityDetail(tx, ctx.workspaceId, String(id).slice(0, 64)));
    return Response.json(detail);
  } catch (err) {
    return errorResponse(err, "GET /api/comms/contacts/[id]");
  }
}
