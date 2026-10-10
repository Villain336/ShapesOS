// ShapesOS — Phase 21A (WS=agentweb): the answer-and-action engine API.
// POST /api/answer { question } → 200 { id, status, payload, usage }
//        payload: claims (each with its citations and supported / unsupported),
//        sources (which provider returned each, a receipt id for cited ones), notes.
//        402 when the workspace has no credits left; 400 for a bad question.
// GET  /api/answer → { answers: AnswerSummary[] }   (the caller's own history)
// Access: any member (viewer+), signed in. The workspace index is searched AS the
// caller (their role, their private records only). One answer costs at most the
// workspace's per-answer credit cap (Settings → Search and answers).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireWorkspaceRole } from "@/lib/authz";
import { httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { AnswerError, listAnswers, runAnswer } from "@/lib/answer/service";

export const dynamic = "force-dynamic";
// An answer may wait on several providers and a model.
export const maxDuration = 60;

const Body = z.object({ question: z.string().min(1).max(2000) });

export async function POST(req: NextRequest) {
  try {
    const { user, workspace, role } = await answerActor();
    if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return Response.json({ error: "Forbidden" }, { status: 403 });
    const { question } = Body.parse(await readJson(req));
    const out = await runAnswer({ workspaceId: workspace.id, userId: user.id, role, question });
    return Response.json({ id: out.id, status: out.status, payload: out.payload, usage: out.usage }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AnswerError) return Response.json({ error: e.message }, { status: e.status });
    return httpErrorResponse(e);
  }
}

export async function GET() {
  try {
    const { user, workspace } = await answerActor();
    return Response.json({ answers: await listAnswers(workspace.id, user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
