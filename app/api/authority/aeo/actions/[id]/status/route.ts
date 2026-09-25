// Marketr — /api/authority/aeo/actions/:id/status
// POST → track an action toward completion.
//   { to: "applied" }  on an owned_fix = run the supervised ladder gate:
//                       the linked authority approval must execute (binding
//                       re-verified, HALTS on mismatch) — never autonomous.
//   { to: "done" | "dismissed" } on any action.
// (editor+)

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { aeoActionStatusSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady } from "@/lib/authority/db";
import { transitionAction, applyOwnedFix, executionPayloadForAction } from "@/lib/authority/aeo/act";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json(
      { error: "Authority tables not provisioned yet (migration pending)." },
      { status: 503 },
    );
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const statusParsed = aeoActionStatusSchema.safeParse(body.to);
  if (!statusParsed.success) return badRequest("Invalid input", statusParsed.error.issues);
  const note = typeof body.note === "string" ? body.note : undefined;

  try {
    if (statusParsed.data === "applied") {
      const action = await prisma.aeoAction.findFirst({
        where: { id, workspaceId: gate.workspaceId },
      });
      if (!action) return Response.json({ error: "AEO action not found in workspace." }, { status: 404 });
      if (action.kind !== "owned_fix") {
        return Response.json(
          { error: "Third-party plans track applied/done directly — no ladder gate." },
          { status: 400 },
        );
      }
      // The ladder: the authority approval must execute with the EXACT
      // approved binding. Any mismatch HALTS — never autonomous.
      const result = await applyOwnedFix({
        id,
        workspaceId: gate.workspaceId,
        actor: gate.userId,
        executionPayload: executionPayloadForAction(action),
      });
      return Response.json(result);
    }
    const result = await transitionAction({
      id,
      workspaceId: gate.workspaceId,
      to: statusParsed.data,
      actor: gate.userId,
      note,
    });
    return Response.json(result);
  } catch (err) {
    return safetyError(err);
  }
}
