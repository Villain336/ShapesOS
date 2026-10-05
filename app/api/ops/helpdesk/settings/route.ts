// ShapesOS Phase 10 (ops-core): GET /api/ops/helpdesk/settings
// The workspace's signed support address (forward your public support@ to
// it) and whether inbound email is configured. Viewer+.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { inboundEmailDomain, supportAddressFor } from "@/lib/messaging/inbound-email";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    let supportAddress: string | null = null;
    try {
      supportAddress = supportAddressFor(workspace.id);
    } catch {
      supportAddress = null; // signing secret missing in production — fail closed
    }
    return Response.json({ inboundConfigured: Boolean(inboundEmailDomain()), supportAddress });
  } catch (err) {
    return errorResponse(err);
  }
}
