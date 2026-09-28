// Marketr — Phase 13B: single style rule.
// PATCH  /api/intelligence/style-rules/[id] { pattern?, replacement?, severity?, pinned?, active? }
// DELETE /api/intelligence/style-rules/[id]

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  workspaceIdFrom,
  requireWorkspaceAccess,
  badRequest,
  notFound,
} from "@/lib/route-utils";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { compilePattern } from "@/lib/intelligence/company/style-check";
import { StyleRuleSeverity } from "@prisma/client";

const SEVERITIES = Object.values(StyleRuleSeverity) as string[];

interface Params {
  params: Promise<{ id: string }>;
}

async function ownedRule(workspaceId: string, id: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.styleRule.findFirst({ where: { id, workspaceId } }),
  );
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: {
    workspaceId?: string;
    pattern?: string;
    replacement?: string | null;
    severity?: string;
    pinned?: boolean;
    active?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const access = await requireWorkspaceAccess(
    user.id,
    workspaceIdFrom(req, body),
    "editor",
  );
  if ("error" in access) return access.error;

  if (body.severity && !SEVERITIES.includes(body.severity)) {
    return badRequest(`severity must be one of: ${SEVERITIES.join(", ")}`);
  }
  if (body.pattern?.trim()) {
    try {
      compilePattern(body.pattern);
    } catch {
      return badRequest("pattern is not a valid regular expression");
    }
  }

  const existing = await ownedRule(access.workspaceId, id);
  if (!existing) return notFound("Style rule not found");

  const updated = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.styleRule.update({
      where: { id: existing.id },
      data: {
        ...(body.pattern?.trim() ? { pattern: body.pattern } : {}),
        ...(body.replacement !== undefined ? { replacement: body.replacement } : {}),
        ...(body.severity ? { severity: body.severity as StyleRuleSeverity } : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        ...(typeof body.active === "boolean" ? { active: body.active } : {}),
      },
    }),
  );
  return Response.json({ rule: updated });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const access = await requireWorkspaceAccess(
    user.id,
    workspaceIdFrom(req),
    "editor",
  );
  if ("error" in access) return access.error;

  const existing = await ownedRule(access.workspaceId, id);
  if (!existing) return notFound("Style rule not found");

  await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.styleRule.delete({ where: { id: existing.id } }),
  );
  return Response.json({ deleted: true });
}
