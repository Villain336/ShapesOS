// Marketr — /api/authority/aeo/prompt-sets/:id/activate
// POST → activate one prompt set; exactly one active per workspace (editor+)

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
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
  try {
    const set = await prisma.aeoPromptSet.findFirst({
      where: { id, workspaceId: gate.workspaceId },
    });
    if (!set) return Response.json({ error: "Prompt set not found in workspace." }, { status: 404 });
    // Exactly one active: deactivate siblings, then activate.
    await prisma.aeoPromptSet.updateMany({
      where: { workspaceId: gate.workspaceId, active: true },
      data: { active: false },
    });
    await prisma.aeoPromptSet.update({ where: { id }, data: { active: true } });
    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "aeo_prompt_set_activated",
      entityType: "aeo_prompt_set",
      entityId: id,
      detail: { version: set.version },
    });
    return Response.json({ id, version: set.version, active: true });
  } catch (err) {
    return safetyError(err);
  }
}
