// ShapesOS — Phase 21A (WS=agentweb): the answer routes' actor (server only).
// Signed in + the current workspace + the member's role (any member may ask;
// what the workspace index shows them is decided by their role and user, as in ⌘K).

import { getMembership } from "@/lib/authz";
import { ForbiddenError } from "@/lib/api/errors";
import { guardWorkspace } from "@/lib/enrichment/guard";

export async function answerActor() {
  const { user, workspace } = await guardWorkspace();
  const m = await getMembership(user.id, workspace.id);
  if (!m) throw new ForbiddenError("You are not a member of this workspace.");
  return { user, workspace, role: m.role };
}
