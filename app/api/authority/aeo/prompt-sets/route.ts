// Marketr — /api/authority/aeo/prompt-sets
// GET  → list versioned prompt sets (workspace-scoped)
// POST → create a versioned prompt set (20–50 money prompts; editor+)

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { aeoPromptSetSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import { validatePrompts, nextVersion, PromptSetValidationError } from "@/lib/authority/aeo/prompts";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ promptSets: [], tablesReady: false });
  }
  const sets = await prisma.aeoPromptSet.findMany({
    where: { workspaceId: gate.workspaceId },
    orderBy: { version: "desc" },
    take: 50,
  });
  return Response.json({
    promptSets: sets.map((s) => ({
      id: s.id,
      version: s.version,
      promptCount: (s.promptsJson as string[]).length,
      active: s.active,
      createdBy: s.createdBy,
      createdAt: s.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json(
      { error: "Authority tables not provisioned yet (migration pending)." },
      { status: 503 },
    );
  }
  const parsed = aeoPromptSetSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  try {
    const prompts = validatePrompts(parsed.data.prompts);
    const existing = await prisma.aeoPromptSet.findMany({
      where: { workspaceId: gate.workspaceId },
      select: { version: true },
    });
    const set = await prisma.aeoPromptSet.create({
      data: {
        workspaceId: gate.workspaceId,
        version: nextVersion(existing.map((e) => e.version)),
        promptsJson: prompts as never,
        createdBy: gate.userId,
        active: false,
      },
    });
    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "aeo_prompt_set_created",
      entityType: "aeo_prompt_set",
      entityId: set.id,
      detail: { version: set.version, promptCount: prompts.length },
    });
    return Response.json(
      { id: set.id, version: set.version, promptCount: prompts.length, active: set.active },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof PromptSetValidationError) return badRequest(err.message);
    return safetyError(err);
  }
}
