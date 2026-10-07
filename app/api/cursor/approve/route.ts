// ShapesOS — Phase 19A (WS=server): POST /api/cursor/approve
// { approvalId, decision: "approve" | "reject", via: "voice" | "click" }
// → { approvalId, status, resultSummary }.
// 403 voice_not_allowed when via = "voice" approves a Tier 3 or destructive
// action — decided SERVER-side from the tool registry (lib/cursor/policy.ts),
// never from anything the client sends. Otherwise it goes through
// executeTool with the person's confirmation (lib/cursor/proposals.ts).
// Editor+ only (roleAtLeast on the current membership); only the person the proposal was
// made for can decide it. Rate limit: write tier.

import { roleAtLeast } from "@/lib/authz";
import { CursorHttpError, cursorErrorResponse, forbiddenCursor, readCursorJson, resolveCursorCaller } from "@/lib/cursor/http";
import { ApproveBodySchema } from "@/lib/cursor/validate";
import { decideCursorProposal } from "@/lib/cursor/proposals";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const caller = await resolveCursorCaller(req);
    if (!roleAtLeast(caller.role, "editor")) throw forbiddenCursor("Viewers can't approve actions.");
    const parsed = ApproveBodySchema.safeParse(await readCursorJson(req, 16 * 1024));
    if (!parsed.success) throw new CursorHttpError(400, "bad_request", "Send { approvalId, decision, via }.");
    const out = await decideCursorProposal({ workspaceId: caller.workspaceId, userId: caller.userId, role: caller.role, ...parsed.data });
    return Response.json(out);
  } catch (err) {
    return cursorErrorResponse(err);
  }
}
