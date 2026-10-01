// Marketr — Wave 2 context.dev slice 5: approve a brand sync.
// POST /api/knowledge/contextdev/brand-sync/[id]/approve — applies the held
// diff to the target kit (creating it when needed). Editor only.

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { approveBrandSync, BrandSyncError } from "@/lib/knowledge/contextdev/brandsync";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  try {
    const { sync, kit } = await approveBrandSync(workspace.id, id);
    return NextResponse.json({ sync, kit: { id: kit.id, name: kit.name } });
  } catch (err) {
    if (err instanceof BrandSyncError) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "BAD_STATE" ? 409 : 502;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
