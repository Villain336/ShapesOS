// Marketr — site audits (milestone 10).
// GET  /api/websites/[id]/audit?projectId=… → inbox payload (settings, latest audit, issues, runs)
// POST /api/websites/[id]/audit { projectId, mock? } → run a scan now

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import { getSiteIdeProvider, ownedSite, siteIsMock } from "@/lib/connectors/source";
import { getAuditInbox, runAudit } from "@/lib/audit/audit";

export const dynamic = "force-dynamic";

const CONTENT_ONLY: string[] = ["wordpress", "webflow"];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const projectId = new URL(req.url).searchParams.get("projectId");
  const site = await ownedSite(user.id, projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  const inbox = await getAuditInbox(site.id);
  return Response.json({ ok: true, site: { id: site.id, name: site.name, sourceType: site.sourceType }, ...inbox });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJsonBody<{ projectId?: string; mock?: boolean }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  if (CONTENT_ONLY.includes(site.sourceType)) {
    return Response.json(
      { error: "Audits scan site files — WordPress and Webflow sites are content-level sources with no file tree to audit." },
      { status: 400 },
    );
  }

  const useMock = body?.mock === true || siteIsMock(site);
  try {
    const provider = useMock ? null : await getSiteIdeProvider(site);
    const result = await runAudit({
      siteId: site.id,
      projectId: site.projectId,
      siteName: site.name,
      provider,
      mock: useMock,
    });
    return Response.json({
      ok: true,
      mock: useMock,
      audit: result.audit,
      issueCount: result.issues.length,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Audit failed" },
      { status: 502 },
    );
  }
}
