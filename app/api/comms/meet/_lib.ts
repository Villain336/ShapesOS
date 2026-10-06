// ShapesOS — Phase 18.2 (WS=comms): /api/comms/meet shared bits (not a route).
// Viewer+ to list, start and join meetings (who sees a meeting is decided in
// lib/comms/meet/meet.server.ts); transcripts, the meeting agent and saving
// its notes are editor+ there.

import { commsGuard } from "../_lib";
import type { MeetCtx } from "@/lib/comms/meet/meet.server";

export async function meetGuard(): Promise<MeetCtx> {
  const ctx = await commsGuard("viewer");
  return { workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role, name: ctx.name, email: ctx.email };
}

export const idParam = (v: string) => String(v ?? "").slice(0, 64);
