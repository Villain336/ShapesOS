// Marketr — MCP workspace opt-in toggle (Phase C, W5). Admin+ only.
//
// GET /api/mcp/settings → { enabled }
// PUT /api/mcp/settings { enabled: boolean } → { enabled }
// OFF by default: the /mcp attack surface only exists after explicit opt-in.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { EntitlementError, entitlementDenied, featureUpgradeMessage, planHasFeature } from "@/lib/billing/entitlements";

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
  return Response.json({
    enabled: ctx.workspace.mcpEnabled,
    // Phase 4a: whether the plan includes API/MCP access.
    entitled: planHasFeature(ctx.workspace.plan, "api_access"),
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
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });
  // Phase 4a: turning the API on needs the api_access entitlement (turning it
  // off is always allowed).
  if (parsed.data.enabled && !planHasFeature(ctx.workspace.plan, "api_access")) {
    return entitlementDenied(new EntitlementError(featureUpgradeMessage("api_access"), "api_access"));
  }
  const updated = await prisma.workspace.update({
    where: { id: ctx.workspace.id },
    data: { mcpEnabled: parsed.data.enabled },
    select: { mcpEnabled: true },
  });
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: null,
        workspaceId: ctx.workspace.id,
        filePath: "(workspace)",
        actor: "user",
        action: "settings_workspace_updated",
        summary: `[mcp] mcp server ${updated.mcpEnabled ? "enabled" : "disabled"}`.slice(0, 500),
        approvedBy: ctx.user.id,
      },
    })
    .catch(() => {});
  return Response.json({ enabled: updated.mcpEnabled });
}
