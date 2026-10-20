// ShapesOS — Phase 18.2 (WS=comms): /api/comms/messages shared bits (not a route).
// Every Messages route is viewer+ (posting, reading and DMs are a member's
// own conversation); who may see a channel is decided in the store
// (lib/comms/messages/store.server.ts: private channels and DMs answer 404
// to non-members). Starting an agent and approving its actions ask for
// editor+ there too.

import { commsGuard } from "../_lib";
import type { MessagesCtx } from "@/lib/comms/messages/store.server";

export async function messagesGuard(): Promise<MessagesCtx> {
  const ctx = await commsGuard("viewer");
  return { workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role, name: ctx.name, email: ctx.email };
}

export const idParam = (v: string) => String(v ?? "").slice(0, 64);
