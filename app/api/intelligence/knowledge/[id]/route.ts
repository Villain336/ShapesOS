// Marketr — Phase 13B: single knowledge entry.
// PATCH  /api/intelligence/knowledge/[id] { title?, body?, confidence?, pinned?, validFrom?, validTo? }
// DELETE /api/intelligence/knowledge/[id]
// Pinned entries stay user-editable here; the pin binds the *learner*
// (worker 6), not this route.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  workspaceIdFrom,
  requireWorkspaceAccess,
  badRequest,
  notFound,
} from "@/lib/route-utils";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

interface Params {
  params: Promise<{ id: string }>;
}

async function ownedEntry(workspaceId: string, id: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.companyKnowledge.findFirst({ where: { id, workspaceId } }),
  );
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: {
    workspaceId?: string;
    title?: string;
    body?: unknown;
    confidence?: number;
    pinned?: boolean;
    validFrom?: string | null;
    validTo?: string | null;
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

  const existing = await ownedEntry(access.workspaceId, id);
  if (!existing) return notFound("Knowledge entry not found");

  const updated = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.companyKnowledge.update({
      where: { id: existing.id },
      data: {
        ...(body.title?.trim() ? { title: body.title.trim().slice(0, 300) } : {}),
        ...(body.body != null && typeof body.body === "object"
          ? { body: body.body as object }
          : {}),
        ...(typeof body.confidence === "number"
          ? { confidence: Math.min(Math.max(body.confidence, 0), 1) }
          : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        ...(body.validFrom !== undefined
          ? { validFrom: body.validFrom ? new Date(body.validFrom) : null }
          : {}),
        ...(body.validTo !== undefined
          ? { validTo: body.validTo ? new Date(body.validTo) : null }
          : {}),
      },
    }),
  );
  return Response.json({ entry: updated });
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

  const existing = await ownedEntry(access.workspaceId, id);
  if (!existing) return notFound("Knowledge entry not found");

  await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.companyKnowledge.delete({ where: { id: existing.id } }),
  );
  return Response.json({ deleted: true });
}
