// Marketr — MCP workspace opt-in toggle (Phase C, W5). Admin+ only.
//
// GET /api/mcp/settings → { enabled, entitled, source, planDefault }
// PUT /api/mcp/settings { enabled: boolean | null } → same shape
// Phase 11 (conncore): ON by default for paid plans with API access (Pro,
// Agency), OFF by default otherwise (lib/mcp/enabled.ts). An admin's explicit
// false is the workspace off switch and always wins; null returns to the
// plan default.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { EntitlementError, entitlementDenied, featureUpgradeMessage, planHasFeature } from "@/lib/billing/entitlements";
import { mcpEffectiveState } from "@/lib/mcp/enabled";

export const dynamic = "force-dynamic";

async function adminCtx() {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) return { error: forbidden() };
  return { user, workspace };
}

export async function GET() {
  const ctx = await adminCtx();
  if ("error" in ctx) return ctx.error;
  const state = mcpEffectiveState(ctx.workspace);
  return Response.json({
    enabled: state.on,
    // Phase 4a: whether the plan includes API/MCP access.
    entitled: state.entitled,
    // Phase 11 (conncore): explicit_on | explicit_off | plan_default.
    source: state.source,
    planDefault: state.planDefault,
  });
}

export async function PUT(req: NextRequest) {
  const ctx = await adminCtx();
  if ("error" in ctx) return ctx.error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = z.object({ enabled: z.boolean().nullable() }).strict().safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });
  // Phase 4a: turning the API on needs the api_access entitlement (turning it
  // off is always allowed).
  if (parsed.data.enabled === true && !planHasFeature(ctx.workspace.plan, "api_access")) {
    return entitlementDenied(new EntitlementError(featureUpgradeMessage("api_access"), "api_access"));
  }
  const updated = await prisma.workspace.update({
    where: { id: ctx.workspace.id },
    data: { mcpEnabled: parsed.data.enabled },
    select: { mcpEnabled: true, plan: true },
  });
  const state = mcpEffectiveState(updated);
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: null,
        workspaceId: ctx.workspace.id,
        filePath: "(workspace)",
        actor: "user",
        action: "settings_workspace_updated",
        summary: `[mcp] mcp server ${updated.mcpEnabled === null ? `reset to the plan default (${state.on ? "on" : "off"})` : updated.mcpEnabled ? "enabled" : "disabled"}`.slice(0, 500),
        approvedBy: ctx.user.id,
      },
    })
    .catch(() => {});
  return Response.json({ enabled: state.on, entitled: state.entitled, source: state.source, planDefault: state.planDefault });
}
