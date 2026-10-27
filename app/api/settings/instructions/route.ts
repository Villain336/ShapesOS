// ShapesOS Phase 25 - shared workspace instructions.
//   GET -> { instructions, revisions, canEdit }   any member (viewer+)
//   PUT { body, expectedRevision } -> { instructions }   admin+; 409 if the
//   text changed since the editor loaded it. Guidance only - see
//   lib/instructions/workspace-instructions.ts.

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { BadRequestError, errorResponse } from "@/lib/api/errors";
import {
  INSTRUCTIONS_MAX_CHARS,
  InstructionsConflictError,
  getInstructions,
  listInstructionRevisions,
  setInstructions,
} from "@/lib/instructions/workspace-instructions";

export const dynamic = "force-dynamic";

const Body = z.object({
  body: z.string().max(INSTRUCTIONS_MAX_CHARS),
  expectedRevision: z.number().int().min(0),
});

export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "viewer");
    if (!m) return forbidden();
    const [instructions, revisions, admin] = await Promise.all([
      getInstructions(workspace.id),
      listInstructionRevisions(workspace.id),
      requireWorkspaceRole(user.id, workspace.id, "admin"),
    ]);
    return Response.json({ instructions, revisions, canEdit: !!admin }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/settings/instructions");
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "admin");
    if (!m) return forbidden();
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(`Instructions must be text up to ${INSTRUCTIONS_MAX_CHARS} characters.`);
    try {
      const instructions = await setInstructions({
        workspaceId: workspace.id,
        userId: user.id,
        userLabel: user.email ?? null,
        body: parsed.data.body,
        expectedRevision: parsed.data.expectedRevision,
      });
      return Response.json({ instructions });
    } catch (err) {
      if (err instanceof InstructionsConflictError) {
        return Response.json({ error: "These instructions changed while you were editing. Reload to see the latest.", currentRevision: err.currentRevision }, { status: 409 });
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err, "PUT /api/settings/instructions");
  }
}
