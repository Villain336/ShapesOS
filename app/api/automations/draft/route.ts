// ShapesOS — Phase 18.3 (WS=flow): POST /api/automations/draft { text }
//   → { draft, problems, mock }
// "Describe it": the workspace's lead model drafts ONE automation in an
// existing format (a scheduled skill or a workflow canvas graph) and the
// result is validated (lib/automations/describe.ts). Nothing is saved or run
// here — the person reviews it and "Create" calls the scheduler / canvas
// routes. Editor+ (creating automations is editor+). Metered like every
// model call; without a live model a labelled mock drafts it.

import { errorResponse } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { prisma } from "@/lib/prisma";
import { DRAFT_TEXT_MAX, draftAutomation } from "@/lib/automations/describe";
import { flowGuard, readJsonObject } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const ctx = await flowGuard("editor");
    if (ctx instanceof Response) return ctx;
    const body = await readJsonObject(req);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return Response.json({ error: "Describe what you want to automate." }, { status: 400 });
    if (text.length > DRAFT_TEXT_MAX) return Response.json({ error: `Keep it under ${DRAFT_TEXT_MAX} characters.` }, { status: 400 });
    const [projects, skills, prefs] = await Promise.all([
      prisma.project.findMany({ where: { workspaceId: ctx.workspaceId }, select: { id: true, domain: true }, orderBy: { createdAt: "asc" }, take: 50 }),
      withWorkspaceScope(ctx.workspaceId, (tx) => tx.skill.findMany({ where: { workspaceId: ctx.workspaceId }, select: { id: true, name: true, description: true }, take: 50 })),
      prisma.userPreference.findUnique({ where: { userId: ctx.userId }, select: { timeZone: true } }).catch(() => null),
    ]);
    const { getLlmProviderForWorkspace } = await import("@/lib/llm/workspace");
    const llm = await getLlmProviderForWorkspace("lead", { workspaceId: ctx.workspaceId, actorId: ctx.userId });
    const result = await draftAutomation(
      text,
      { workspaceId: ctx.workspaceId, projects: projects.map((p) => ({ id: p.id, name: p.domain })), skills, timezone: prefs?.timeZone ?? "UTC" },
      { llm },
    );
    return Response.json(result);
  } catch (err) {
    return errorResponse(err, "POST /api/automations/draft", req);
  }
}
