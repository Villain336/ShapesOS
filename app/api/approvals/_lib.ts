// ShapesOS — /api/approvals shared guard (not a route: no HTTP exports).
// Signed-in member of the current workspace → an InboxViewer carrying the
// role + grants every queue's own rule is evaluated against.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden } from "@/lib/authz";
import { resolveInboxViewer, type InboxViewer } from "@/lib/approvals/inbox";

export async function inboxGuard(): Promise<InboxViewer | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const viewer = await resolveInboxViewer(user.id, workspace.id);
  if (!viewer) return forbidden();
  return viewer;
}
