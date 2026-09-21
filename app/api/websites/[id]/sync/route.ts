// Marketr — pull remote → working copy (milestone 7).
// POST /api/websites/[id]/sync { projectId } → { ok, fileCount, mock, noop? }
//
// GitHub/SFTP sites: every remote file is copied into the local working copy
// (the IDE edits the working copy). File-source sites: no-op.

import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import {
  collectAllFiles,
  getSiteIdeProvider,
  getSiteRemote,
  ownedSite,
} from "@/lib/connectors/source";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await readJsonBody<{ projectId?: string }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "editor"))) return forbidden();

  const working = await getSiteIdeProvider(site);
  const remote = await getSiteRemote(site).catch((err: unknown) => ({
    error: err instanceof Error ? err.message : "Cannot reach remote",
  }));
  if (remote && "error" in remote) {
    return Response.json({ error: remote.error }, { status: 502 });
  }
  if (!remote) {
    return Response.json({ ok: true, noop: true, fileCount: 0, mock: false });
  }

  const isMock =
    (remote.kind === "github" && !remote.connector.isLive) ||
    (remote.kind === "sftp" && !remote.provider.isLive);

  try {
    const provider = remote.kind === "github" ? remote.connector : remote.provider;
    const paths = await collectAllFiles(provider);
    let count = 0;
    for (const p of paths) {
      const { content } = await provider.readFile(p);
      await working.writeFile(p, content);
      count++;
    }
    return Response.json({ ok: true, fileCount: count, mock: isMock });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Sync failed" },
      { status: 502 },
    );
  }
}
