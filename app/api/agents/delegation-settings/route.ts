// ShapesOS — Phase 16: Settings → Automation → "Automatic delegation".
//
// GET → { autoDelegation, limits, stored, defaults, bounds }
//   autoDelegation: the lead is offered delegate_tasks (default on);
//   limits: what is in force (stored overrides, else the code defaults);
//   stored: the workspace's own values (null = default).
// PUT { autoDelegation?, maxParallelPerRun?, maxLivePerWorkspace?, maxWidth?,
//       maxDepth? } (each limit an integer inside its bounds, or null = back
//   to the default) → the same shape as GET.
//
// Access: reads need viewer; changes need editor (they change what agents
// may do on their own). Every read/write is RLS-scoped to the workspace.
// Delegation never loosens an approval: money and irreversible actions ask
// in every sub-agent, whatever is set here.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { z } from "zod";
import { DEFAULT_DELEGATION_LIMITS, DELEGATION_LIMIT_BOUNDS, type DelegationLimits } from "@/lib/agents/delegation/plan";
import { loadDelegationSettings } from "@/lib/agents/delegation/store";
import { automationGuard, badRequest, readJson } from "../../automation/_lib";

export const dynamic = "force-dynamic";

const limit = (k: keyof DelegationLimits) =>
  z.number().int().min(DELEGATION_LIMIT_BOUNDS[k][0]).max(DELEGATION_LIMIT_BOUNDS[k][1]).nullable().optional();

const BodySchema = z
  .object({
    autoDelegation: z.boolean().optional(),
    maxParallelPerRun: limit("maxParallelPerRun"),
    maxLivePerWorkspace: limit("maxLivePerWorkspace"),
    maxWidth: limit("maxWidth"),
    maxDepth: limit("maxDepth"),
  })
  .strict();

async function payload(workspaceId: string) {
  const s = await loadDelegationSettings(workspaceId);
  return {
    autoDelegation: s.autoDelegation,
    limits: s.limits,
    stored: s.stored,
    defaults: DEFAULT_DELEGATION_LIMITS,
    bounds: DELEGATION_LIMIT_BOUNDS,
  };
}

export async function GET() {
  const access = await automationGuard("viewer");
  if (access instanceof Response) return access;
  return Response.json(await payload(access.workspaceId));
}

export async function PUT(req: Request) {
  const access = await automationGuard("editor");
  if (access instanceof Response) return access;
  const parsed = BodySchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return badRequest(
      "Invalid delegation settings.",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const b = parsed.data;
  const data = {
    ...(b.autoDelegation === undefined ? {} : { autoDelegation: b.autoDelegation }),
    ...(b.maxParallelPerRun === undefined ? {} : { maxParallelPerRun: b.maxParallelPerRun }),
    ...(b.maxLivePerWorkspace === undefined ? {} : { maxLivePerWorkspace: b.maxLivePerWorkspace }),
    ...(b.maxWidth === undefined ? {} : { maxWidth: b.maxWidth }),
    ...(b.maxDepth === undefined ? {} : { maxDepth: b.maxDepth }),
  };
  await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.agentDelegationSetting.upsert({
      where: { workspaceId: access.workspaceId },
      create: { workspaceId: access.workspaceId, updatedBy: access.userId, ...data },
      update: { updatedBy: access.userId, ...data },
    }),
  );
  return Response.json(await payload(access.workspaceId));
}
