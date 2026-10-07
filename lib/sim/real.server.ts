// ShapesOS — Phase 19B (WS=engine): "do this for real".
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// A rehearsed intervention never touches a real record by itself. "Do this
// for real" turns ONE of them into a normal proposal through executeTool —
// the same gates a chat turn's tool call takes (grant, role, the
// confirmation gate, audit): apply_launch_change (Tier 2: asks unless an
// automation rule says Auto-run) or, for an ad campaign,
// fund_launch_ad_campaign (Tier 3, spend: it ALWAYS asks a person; no rule
// can auto-approve it). The first call returns the pending proposal; only
// the person's explicit OK (confirmed: true, like answering "yes" in chat)
// runs it.

import { HttpError } from "@/lib/api/errors";
import { gate, type PanelActor } from "@/lib/panel/service.server";
import { prisma } from "@/lib/prisma";
import { getTownRun } from "./service.server";
import { realActionFor } from "./tools";

export interface RealProposal {
  tool: string;
  label: string;
  /** pending_confirmation = the proposal waits for the person's OK; executed = it ran. */
  status: string;
  summary: string;
}

export async function proposeForReal(actor: PanelActor, runId: string, input: { variant: "A" | "B"; index: number; confirmed?: boolean }): Promise<RealProposal> {
  await gate(actor, "editor");
  const run = await getTownRun(actor, runId);
  const scenario = input.variant === "B" ? run.scenarioB : run.scenarioA;
  const iv = scenario?.interventions[input.index];
  if (!iv) throw new HttpError(404, "That intervention wasn't found in the run.");
  const { tool, label } = realActionFor(iv);
  const project = await prisma.project.findFirst({ where: { workspaceId: actor.workspaceId }, select: { id: true }, orderBy: { createdAt: "asc" } });
  // The agent loop registers its own tools on import; executeTool is the one gate path.
  await import("@/lib/chat/agent");
  const { executeTool } = await import("@/lib/chat/tool-exec");
  const args = { runId, variant: input.variant, index: input.index };
  const call: import("@/lib/chat/tool-exec").ChatToolCall = { tool, args, status: "pending_confirmation" };
  await executeTool({ projectId: project?.id ?? "", workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role, confirmed: input.confirmed === true, agentKey: "lead" }, tool, args, call);
  return { tool, label, status: call.status, summary: call.resultSummary ?? "" };
}
