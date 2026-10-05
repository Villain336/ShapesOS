// ShapesOS — /api/integrations/activepieces/bindings (Phase 1, H6).
//
// The Activepieces engine is host-wide; a flow is usable only from the
// workspace it is bound to (lib/integrations/activepieces/bindings.ts).
//   GET                         flow ids bound to the caller's workspace (viewer+)
//   POST   { flowId, workspaceId? }   bind a flow (platform operators only;
//                                     defaults to the operator's active workspace)
//   DELETE ?flowId=&workspaceId=      unbind (platform operators only)

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace } from "@/lib/session";
import { requirePlatformOperator } from "@/lib/auth/require-platform-operator";
import { bindFlowToWorkspace, prismaFlowBindingStore } from "@/lib/integrations/activepieces";
import { integrationsGuard, badRequest, engineError } from "../_lib";

export const dynamic = "force-dynamic";

const BindSchema = z.object({
  flowId: z.string().trim().min(1).max(128),
  workspaceId: z.string().trim().min(1).max(64).optional(),
});

async function targetWorkspace(
  operator: { id: string; email: string | null },
  workspaceId: string | null | undefined,
): Promise<string | Response> {
  if (!workspaceId) return (await getOrCreateWorkspace(operator.id, operator.email ?? "")).id;
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
  if (!ws) return Response.json({ error: "Workspace not found." }, { status: 404 });
  return ws.id;
}

export async function GET() {
  const gate = await integrationsGuard("viewer");
  if (gate instanceof Response) return gate;
  const flowIds = await prismaFlowBindingStore().listFlowIds(gate.workspaceId);
  return Response.json({ workspaceId: gate.workspaceId, flowIds });
}

export async function POST(req: Request) {
  const operator = await requirePlatformOperator();
  if (operator instanceof Response) return operator;
  const parsed = BindSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("flowId is required.");
  const workspaceId = await targetWorkspace(operator, parsed.data.workspaceId);
  if (workspaceId instanceof Response) return workspaceId;
  try {
    await bindFlowToWorkspace(workspaceId, parsed.data.flowId, operator.id);
    return Response.json({ ok: true, workspaceId, flowId: parsed.data.flowId });
  } catch (e) {
    return engineError(e);
  }
}

export async function DELETE(req: Request) {
  const operator = await requirePlatformOperator();
  if (operator instanceof Response) return operator;
  const url = new URL(req.url);
  const flowId = url.searchParams.get("flowId")?.trim();
  if (!flowId) return badRequest("flowId is required.");
  const workspaceId = await targetWorkspace(operator, url.searchParams.get("workspaceId"));
  if (workspaceId instanceof Response) return workspaceId;
  const removed = await prismaFlowBindingStore().unbind(workspaceId, flowId);
  if (!removed) return Response.json({ error: "Binding not found." }, { status: 404 });
  return Response.json({ ok: true, workspaceId, flowId });
}
