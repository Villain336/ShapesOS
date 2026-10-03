// Marketr — Knowledge Brain: removal-flag management.
// GET    /api/corpus/remove          → current removal flags (viewer+)
// POST   /api/corpus/remove          → flag a source for removal (platform operators)
//   { sourceId, reason } — marks only; ingested data is NEVER deleted here.
//   Flags take effect on the next corpus rebuild (the ingest script honors
//   data/corpus/removals.json).
// DELETE /api/corpus/remove?sourceId=… → clear a flag (platform operators)
//
// The corpus is SHARED by every tenant on the install, so mutations are not
// a workspace role: only MARKETR_PLATFORM_OPERATORS may change it (Phase 1).

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { requirePlatformOperator } from "@/lib/auth/require-platform-operator";
import {
  listRemovals,
  flagRemoval,
  unflagRemoval,
  sanitizeId,
} from "@/lib/intelligence/corpus/proposals";

export const dynamic = "force-dynamic";

async function authed(min: "viewer") {
  const user = await requireUser();
  if (!user) return { err: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, min);
  if (!membership) return { err: forbidden() };
  return { user };
}

export async function GET() {
  const a = await authed("viewer");
  if (a.err) return a.err;
  return Response.json({ flags: listRemovals() });
}

export async function POST(req: Request) {
  const user = await requirePlatformOperator();
  if (user instanceof Response) return user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const sourceId = sanitizeId(body.sourceId);
  if (!sourceId) return Response.json({ error: "sourceId is required" }, { status: 400 });
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!reason) return Response.json({ error: "reason is required" }, { status: 400 });

  flagRemoval(sourceId, reason, user.email ?? user.id);
  return Response.json({ ok: true, sourceId });
}

export async function DELETE(req: Request) {
  const op = await requirePlatformOperator();
  if (op instanceof Response) return op;
  const sourceId = sanitizeId(new URL(req.url).searchParams.get("sourceId"));
  if (!sourceId) return Response.json({ error: "sourceId is required" }, { status: 400 });
  if (!unflagRemoval(sourceId)) return Response.json({ error: "flag not found" }, { status: 404 });
  return Response.json({ ok: true });
}
