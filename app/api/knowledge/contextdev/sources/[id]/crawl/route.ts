// Marketr — Wave 2 context.dev slice 2: crawl trigger API.
// POST /api/knowledge/contextdev/sources/[id]/crawl — queue and run a
// crawl for an active source (bounded pages; budget-gated before the API).

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { queueCrawlJob, runCrawlJob, CrawlError, MAX_PAGES_CAP } from "@/lib/knowledge/contextdev/crawl";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  let maxPages: number | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (body.maxPages !== undefined) {
      maxPages = Number(body.maxPages);
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_CAP) {
        return NextResponse.json(
          { error: `maxPages must be an integer 1–${MAX_PAGES_CAP}` },
          { status: 400 },
        );
      }
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const job = await queueCrawlJob(workspace.id, id);
    const result = await runCrawlJob(workspace.id, job.id, { maxPages });
    return NextResponse.json({ job: { ...job, status: "complete" }, result });
  } catch (err) {
    if (err instanceof CrawlError) {
      const status =
        err.code === "NOT_FOUND" ? 404 : err.code === "SOURCE_NOT_ACTIVE" ? 409 : 502;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
