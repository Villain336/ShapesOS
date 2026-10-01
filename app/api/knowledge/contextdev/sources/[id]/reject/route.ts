// Marketr — Wave 2 context.dev slice 2: source rejection API.
// POST /api/knowledge/contextdev/sources/[id]/reject — archive a source
// (declines the third-party approval request).

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { rejectSource, KnowledgeSourceError } from "@/lib/knowledge/contextdev/sources";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  try {
    const source = await rejectSource(workspace.id, id);
    return NextResponse.json({ source });
  } catch (err) {
    if (err instanceof KnowledgeSourceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
    }
    throw err;
  }
}
