// Marketr — Wave 2 context.dev slice 2: sources API.
// GET /api/knowledge/contextdev/sources — list the workspace's sources.
// POST — register a source (governed: own domains auto-activate,
// third-party domains land at pending_approval).

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import {
  registerSource,
  listSources,
  KnowledgeSourceError,
  KNOWLEDGE_SOURCE_TYPES,
  KNOWLEDGE_SOURCE_CADENCES,
} from "@/lib/knowledge/contextdev/sources";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sources = await listSources(workspace.id);
  return NextResponse.json({ sources });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { url?: string; sourceType?: string; cadence?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.url?.trim()) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  if (!KNOWLEDGE_SOURCE_TYPES.includes(body.sourceType as never)) {
    return NextResponse.json(
      { error: `sourceType must be one of: ${KNOWLEDGE_SOURCE_TYPES.join(", ")}` },
      { status: 400 },
    );
  }
  if (body.cadence && !KNOWLEDGE_SOURCE_CADENCES.includes(body.cadence as never)) {
    return NextResponse.json(
      { error: `cadence must be one of: ${KNOWLEDGE_SOURCE_CADENCES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const source = await registerSource(workspace.id, {
      url: body.url,
      sourceType: body.sourceType as "page" | "sitemap" | "brand",
      cadence: (body.cadence as "manual" | "daily" | "weekly" | undefined) ?? "manual",
    });
    return NextResponse.json({ source }, { status: 201 });
  } catch (err) {
    if (err instanceof KnowledgeSourceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}
