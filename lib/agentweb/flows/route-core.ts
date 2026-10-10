// ShapesOS — Phase 21A round 2 (WS=agentweb): the logic behind the flows routes, with the actor
// passed in (testable without a session).
//   teach      a session's recorded steps become a DRAFT flow            (editor+)
//   rename     change its name                                          (editor+)
//   publish    let agents run it: only a person's click (channel ui_click) on this app's page  (editor+)
//   unpublish  back to a draft                                          (editor+)
//   workflow   a validated workflow DRAFT (Automations drafter rules) the page then creates through
//              the Automations app's own routes; nothing is created here
// A flow never runs from here: running is the web_flow_run tool, which refuses a draft.

import { prisma } from "@/lib/prisma";
import { roleAtLeast } from "@/lib/authz";
import { humanClickGuard } from "../commerce/http";
import { flowWorkflowDraft } from "./draft";
import { createFlowFromRun, FlowStoreError, getFlow, publishFlow, renameFlow, unpublishFlow } from "./store";

export interface Actor {
  userId: string;
  workspaceId: string;
  role: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function handleFlowOp(actor: Actor, req: Request): Promise<Response> {
  const guard = await humanClickGuard(req, { requireChannel: false, subject: "A flow" });
  if (!guard.ok) return json({ error: guard.error }, guard.status);
  if (!roleAtLeast(actor.role as never, "editor")) return json({ error: "Only an editor or above can teach, publish or change flows." }, 403);
  const body = guard.body;
  const op = typeof body.op === "string" ? body.op : "";
  const id = typeof body.id === "string" ? body.id : "";
  try {
    if (op === "teach") {
      const runId = typeof body.runId === "string" ? body.runId : "";
      if (!ID.test(runId)) return json({ error: "Say which session to teach from." }, 400);
      return json({ flow: await createFlowFromRun(actor.workspaceId, actor.userId, runId, typeof body.name === "string" ? body.name : undefined) }, 201);
    }
    if (!ID.test(id)) return json({ error: "Say which flow." }, 400);
    if (op === "rename") return json({ flow: await renameFlow(actor.workspaceId, id, typeof body.name === "string" ? body.name : "") });
    if (op === "publish") {
      // Publishing lets agents run it: it needs the person's own click, not a script or an assistant.
      if (body.channel !== "ui_click") return json({ error: "A flow is published only by the person clicking Publish (channel ui_click)." }, 403);
      return json({ flow: await publishFlow(actor.workspaceId, id, actor.userId) });
    }
    if (op === "unpublish") return json({ flow: await unpublishFlow(actor.workspaceId, id) });
    if (op === "workflow") {
      const f = await getFlow(actor.workspaceId, id);
      if (!f) return json({ error: "That flow was not found." }, 404);
      const [projects, prefs] = await Promise.all([
        prisma.project.findMany({ where: { workspaceId: actor.workspaceId }, select: { id: true, domain: true }, orderBy: { createdAt: "asc" }, take: 50 }),
        prisma.userPreference.findUnique({ where: { userId: actor.userId }, select: { timeZone: true } }).catch(() => null),
      ]);
      if (projects.length === 0) return json({ error: "A workflow lives in a project. Add a project first." }, 409);
      const timezone = prefs?.timeZone ?? "UTC";
      // Lazy: the drafter validates against the whole agent tool registry.
      const { validateDraft } = await import("@/lib/automations/describe");
      const v = validateDraft(flowWorkflowDraft(f, { projectId: projects[0].id, timezone }), { workspaceId: actor.workspaceId, projects: projects.map((p) => ({ id: p.id, name: p.domain })), skills: [], timezone });
      if (!v.ok) return json({ error: v.problems.join(" ") }, 422);
      return json({ draft: v.draft, problems: [], mock: false, published: f.status === "published" });
    }
    return json({ error: "Unknown operation." }, 400);
  } catch (e) {
    if (e instanceof FlowStoreError) return json({ error: e.message, code: e.code }, e.code === "not_found" ? 404 : 409);
    throw e;
  }
}
