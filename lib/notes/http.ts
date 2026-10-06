// ShapesOS — Phase 18.2 (WS=content): the Notes routes' actor (server only).
// Every notes route first runs guardWorkspace() (signed in + the current
// workspace; the M11 battery's authorization primitive), then this resolves
// the member's role. Not a member → 403. What a member may do with one note
// (read / edit / share / delete) is decided per note in lib/notes/service.ts.

import { getMembership } from "@/lib/authz";
import { ForbiddenError } from "@/lib/api/errors";
import type { NoteActor } from "./service";

export async function noteActor(userId: string, workspaceId: string): Promise<NoteActor> {
  const m = await getMembership(userId, workspaceId);
  if (!m) throw new ForbiddenError("You are not a member of this workspace.");
  return { workspaceId, userId, role: m.role };
}
