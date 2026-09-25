// Marketr — POST /api/flywheel/launch/checklist/:id/reopen (editor)
// Re-open an item (back to in_progress) with a note — e.g. the evidence went
// stale or a re-audit is needed.

import type { NextRequest } from "next/server";
import { launchGuard, badRequest, readJson } from "@/app/api/flywheel/launch/_lib";
import { reopenItemSchema } from "@/app/api/flywheel/launch/_schemas";
import { launchTablesReady, reopenChecklistItem, LaunchChecklistError } from "@/lib/flywheel/launch/store";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await launchGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await launchTablesReady())) {
    return Response.json({ error: "Launch tables not provisioned yet." }, { status: 503 });
  }
  const { id } = await ctx.params;
  const parsed = reopenItemSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  const found = (await prisma.$queryRawUnsafe(
    `SELECT "key" FROM launch_checklist WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    id,
    gate.workspaceId,
  )) as { key: string }[];
  if (found.length === 0) return Response.json({ error: "Checklist item not found" }, { status: 404 });

  try {
    const row = await reopenChecklistItem({
      workspaceId: gate.workspaceId,
      key: found[0].key,
      note: parsed.data.note,
    });
    return Response.json({ item: row });
  } catch (err) {
    if (err instanceof LaunchChecklistError) return badRequest(err.message);
    throw err;
  }
}
