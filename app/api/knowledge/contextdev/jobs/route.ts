// Marketr — Wave 2 context.dev slice 2: crawl jobs API.
// GET /api/knowledge/contextdev/jobs — recent crawl jobs with their sources.

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { listCrawlJobs } from "@/lib/knowledge/contextdev/crawl";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const jobs = await listCrawlJobs(workspace.id);
  return NextResponse.json({ jobs });
}
