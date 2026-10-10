// ShapesOS — Phase 21A (WS=agentweb): act on an answer or one of its sources.
// POST /api/answer/act { answerId, action, sourceId? }
//   action: save_note | save_drive | add_crm | monitor_page | draft_email
//   → { status, summary } for a tool action (it runs through executeTool and every gate
//      the tool already has; the person's click is their confirmation of THAT action,
//      never of money or deletion), or { link } for draft_email (opens Mail with the
//      draft filled in; nothing is sent).
// Access: editor+ (the tools need it), and only the person whose answer it is.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceRole } from "@/lib/authz";
import { BadRequestError, ForbiddenError } from "@/lib/api/errors";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import "@/lib/answer/tools";
import "@/lib/documents/tools";
import { ACTION_IDS, buildAction } from "@/lib/answer/actions";
import { getAnswer } from "@/lib/answer/service";

export const dynamic = "force-dynamic";

const Body = z.object({ answerId: z.string().min(1).max(64), action: z.enum(ACTION_IDS), sourceId: z.number().int().positive().max(50).optional() });

export async function POST(req: NextRequest) {
  try {
    const { user, workspace } = await guardWorkspace();
    const member = await requireWorkspaceRole(user.id, workspace.id, "editor");
    if (!member) throw new ForbiddenError("Acting on an answer needs the editor role.");
    const body = Body.parse(await readJson(req));
    const answer = await getAnswer(workspace.id, user.id, body.answerId);
    if (!answer) return Response.json({ error: "Not found" }, { status: 404 });
    const built = buildAction(body.action, answer.payload, body.sourceId);
    if (!built) throw new BadRequestError("That action needs a web source from the list.");
    if (built.kind === "link") return Response.json({ link: built.href });
    const project = await prisma.project.findFirst({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
    const call: ChatToolCall = { tool: built.tool, args: built.args, status: "executed", agentKey: "lead" };
    // The click is the confirmation of this one action; Tier 3 and the tool's own gates still apply.
    await executeTool({ projectId: project?.id ?? "", workspaceId: workspace.id, userId: user.id, role: member.role, confirmed: true, agentKey: "lead", grant: null }, built.tool, built.args, call);
    return Response.json({ status: call.status, summary: call.resultSummary ?? "" }, { status: call.status === "executed" ? 200 : 409 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
