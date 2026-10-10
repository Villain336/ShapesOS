// ShapesOS — Phase 21A round 2 (WS=agentweb): the logic behind the Agent sessions routes, with the
// actor passed in (testable without a session). Supervising a session is editor+: pausing, taking
// over, sending a step, approving or rejecting a proposal, review-each-step, caps. Looking is any member.

import { roleAtLeast } from "@/lib/authz";
import { humanClickGuard } from "../commerce/http";
import { approveProposal, rejectProposal, runHumanStep } from "./human";
import { control, getSessionView, SessionError, setCaps, setStepMode } from "./store";
import type { Action } from "./control";

export interface Actor {
  userId: string;
  workspaceId: string;
  role: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const CONTROL_OPS = new Set<Action>(["pause", "resume", "takeover", "handback"]);

export async function handleSessionOp(actor: Actor, req: Request, runId: string): Promise<Response> {
  const guard = await humanClickGuard(req, { requireChannel: false });
  if (!guard.ok) return json({ error: guard.error }, guard.status);
  if (!roleAtLeast(actor.role as never, "editor")) return json({ error: "Only an editor or above can supervise a session." }, 403);
  const body = guard.body;
  const op = typeof body.op === "string" ? body.op : "";
  try {
    if (CONTROL_OPS.has(op as Action)) return json({ session: await control(actor.workspaceId, runId, actor.userId, op as Action) });
    if (op === "step") {
      const tool = typeof body.tool === "string" ? body.tool : "";
      const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
      const result = await runHumanStep(actor.workspaceId, runId, actor, { tool, args }, { requireControl: true });
      return json({ result, session: await getSessionView(actor.workspaceId, runId) });
    }
    if (op === "approve" || op === "reject") {
      const id = typeof body.proposalId === "string" ? body.proposalId : "";
      if (op === "approve") {
        const result = await approveProposal(actor.workspaceId, runId, id, actor);
        return json({ result, session: await getSessionView(actor.workspaceId, runId) });
      }
      await rejectProposal(actor.workspaceId, runId, id);
      return json({ session: await getSessionView(actor.workspaceId, runId) });
    }
    if (op === "step_mode") return json({ session: await setStepMode(actor.workspaceId, runId, body.mode === "approve_each" ? "approve_each" : "auto") });
    if (op === "caps") {
      const n = (v: unknown) => (typeof v === "number" ? v : undefined);
      return json({ session: await setCaps(actor.workspaceId, runId, { maxSteps: n(body.maxSteps), maxSeconds: n(body.maxSeconds), maxCredits: n(body.maxCredits) }) });
    }
    return json({ error: "Unknown operation." }, 400);
  } catch (e) {
    if (e instanceof SessionError) return json({ error: e.message, code: e.code }, e.code === "not_found" ? 404 : 409);
    throw e;
  }
}
