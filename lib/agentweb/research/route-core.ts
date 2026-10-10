// ShapesOS — Phase 21A round 2 (WS=agentweb): the logic behind the research routes, with the actor
// passed in (testable without a session). Same-origin JSON only (the click guard). Starting,
// reading and annotating research is any member who can ask (viewer+); clipping into other apps and
// sharing need the role the tool or the share needs (editor+).

import { createHash } from "node:crypto";
import { roleAtLeast } from "@/lib/authz";
import { humanClickGuard } from "../commerce/http";
import { appendFact } from "@/lib/substrate/graph/facts";
import { addPageToResearch } from "./page";
import { buildClip, CLIP_TARGETS, type ClipTarget } from "./clip";
import { attachAnswer, createResearch, getResearch, removeResearch, ResearchError, updateResearch } from "./store";

export interface Actor {
  userId: string;
  workspaceId: string;
  role: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function handleResearchOp(actor: Actor, req: Request): Promise<Response> {
  const guard = await humanClickGuard(req, { requireChannel: false, subject: "Research", maxChars: 40_000 });
  if (!guard.ok) return json({ error: guard.error }, guard.status);
  const body = guard.body;
  const op = typeof body.op === "string" ? body.op : "";
  const id = typeof body.id === "string" ? body.id : "";
  try {
    if (op === "create") {
      const created = await createResearch(actor.workspaceId, actor.userId, { question: String(body.question ?? ""), title: typeof body.title === "string" ? body.title : undefined, answerId: typeof body.answerId === "string" && ID.test(body.answerId) ? body.answerId : undefined });
      return json({ research: created }, 201);
    }
    if (!ID.test(id)) return json({ error: "Say which research." }, 400);
    if (op === "update") {
      const patch = body.patch && typeof body.patch === "object" && !Array.isArray(body.patch) ? (body.patch as Record<string, unknown>) : {};
      const view = await updateResearch(actor.workspaceId, actor.userId, actor.role, id, {
        ...(typeof patch.title === "string" ? { title: patch.title } : {}),
        ...(typeof patch.notes === "string" ? { notes: patch.notes } : {}),
        ...(typeof patch.status === "string" ? { status: patch.status } : {}),
        ...(typeof patch.shareState === "string" ? { shareState: patch.shareState } : {}),
        ...(patch.runId === null || (typeof patch.runId === "string" && ID.test(patch.runId)) ? { runId: patch.runId as string | null } : {}),
      });
      return json({ research: view });
    }
    if (op === "remove") {
      await removeResearch(actor.workspaceId, actor.userId, id);
      return json({ ok: true });
    }
    if (op === "attach_answer") {
      const answerId = typeof body.answerId === "string" ? body.answerId : "";
      if (!ID.test(answerId)) return json({ error: "Say which answer." }, 400);
      await attachAnswer(actor.workspaceId, actor.userId, id, answerId);
      return json({ research: await getResearch(actor.workspaceId, actor.userId, id, { includeWorkspace: true }) });
    }
    if (op === "attach_page") {
      const res = await addPageToResearch(actor.workspaceId, actor.userId, id, String(body.url ?? ""));
      if (!res.ok) return json({ outcome: res.outcome }, 422);
      return json({ captureId: res.captureId, remembered: res.remembered, research: await getResearch(actor.workspaceId, actor.userId, id, { includeWorkspace: true }) });
    }
    if (op === "clip") return await clip(actor, id, body);
    return json({ error: "Unknown operation." }, 400);
  } catch (e) {
    if (e instanceof ResearchError) return json({ error: e.message, code: e.code }, e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : e.code === "limit" ? 409 : 400);
    throw e;
  }
}

async function clip(actor: Actor, id: string, body: Record<string, unknown>): Promise<Response> {
  const target = body.target as ClipTarget;
  if (!(CLIP_TARGETS as readonly string[]).includes(target)) return json({ error: "Unknown clip target." }, 400);
  if (!roleAtLeast(actor.role as never, "editor")) return json({ error: "Clipping into other apps needs the editor role." }, 403);
  // What leaves the research is the owner's web research; their private workspace records stay out.
  const view = await getResearch(actor.workspaceId, actor.userId, id, { includeWorkspace: false });
  if (!view) return json({ error: "That research was not found." }, 404);
  const c = body.contact && typeof body.contact === "object" && !Array.isArray(body.contact) ? (body.contact as Record<string, string>) : undefined;
  const built = buildClip(view, { target, url: typeof body.url === "string" ? body.url : undefined, contact: c });
  if (!built) return json({ error: target === "contact" ? "Give the contact a name." : "That clip needs a web page from the list." }, 400);
  if (built.kind === "graph") {
    const key = createHash("sha256").update(`${id}|${built.url}`).digest("hex").slice(0, 24);
    await appendFact({
      workspaceId: actor.workspaceId,
      source: "agentweb-clip",
      sourceRecordId: key,
      entityRef: `content:${built.url}`,
      factType: "web_page_clipped",
      payload: { displayName: built.title.slice(0, 200) || built.url, core: { url: built.url, title: built.title.slice(0, 200) }, properties: { excerpt: built.excerpt.slice(0, 400), researchId: id, clippedBy: actor.userId } },
      actor: actor.userId,
    });
    return json({ status: "executed", summary: "Added the page to the business graph as a content record." });
  }
  const { prisma } = await import("@/lib/prisma");
  const { executeTool } = await import("@/lib/chat/tool-exec");
  const project = await prisma.project.findFirst({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const call: import("@/lib/chat/tool-exec").ChatToolCall = { tool: built.tool, args: built.args, status: "executed", agentKey: "lead" };
  // The click is the confirmation of this one action; the tool's own gates (and Tier 3) still apply.
  await executeTool({ projectId: project?.id ?? "", workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role as never, confirmed: true, agentKey: "lead", grant: null }, built.tool, built.args, call);
  return json({ status: call.status, summary: call.resultSummary ?? "" }, call.status === "executed" ? 200 : 409);
}
