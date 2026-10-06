// ShapesOS — Phase 18.2 (WS=comms): Contacts — the address book.
//   GET /api/comms/contacts[?q=&offset=] → { items, total, pendingSuggestions }   (viewer+)
// One row per person across the four people stores (identity links;
// lib/comms/contacts/store.ts). Opening it links records created since the
// last sync (at most once a minute) — links only; merging is a person's call.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listIdentities } from "@/lib/comms/contacts/store";
import { ensureFreshContacts } from "@/lib/comms/contacts/sync.server";
import { commsGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ctx = await commsGuard("viewer");
    await ensureFreshContacts(ctx.workspaceId);
    const q = req.nextUrl.searchParams.get("q");
    const offset = Number(req.nextUrl.searchParams.get("offset") ?? 0) || 0;
    const [list, pendingSuggestions] = await withWorkspaceScope(ctx.workspaceId, async (tx) =>
      Promise.all([
        listIdentities(tx, { workspaceId: ctx.workspaceId, q, limit: 50, offset }),
        tx.contactMergeSuggestion.count({ where: { workspaceId: ctx.workspaceId, status: "pending" } }),
      ]),
    );
    return Response.json({ ...list, pendingSuggestions });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/contacts");
  }
}
