// ShapesOS — GET /api/agents/tool-availability → { groups: { code: { ok, reason? } }, codeProvider }
//
// Phase 8: which tool groups this server can run right now. The New task
// composer reads it so the Code chip lights up exactly when a sandbox
// provider (Docker / E2B / Daytona) reports available, and otherwise shows
// the reason. Any member of the current workspace (viewer+); reveals no
// key material — only whether a provider answers, and why not.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership, forbidden } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { toolGroupAvailability } from "@/lib/sandbox/availability";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) return forbidden();
  try {
    const { codeProvider, ...groups } = await toolGroupAvailability();
    return Response.json({ groups, codeProvider }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e, "GET /api/agents/tool-availability");
  }
}
