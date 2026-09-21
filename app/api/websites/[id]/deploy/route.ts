// Marketr — push working copy → remote (milestone 7).
// POST /api/websites/[id]/deploy { projectId, message? }
//   → { ok, fileCount, perFile: [{ path, ok }], commitSha?, downloadUrl?, mock }
//
// GitHub: all working-copy files pushed in ONE commit (Git Data API) —
//   returns the commit SHA.
// SFTP: each file written over the milestone-6 SFTP provider.
// File-source: nothing to push to — returns a zip download URL instead.

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
  const body = await readJsonBody<{ projectId?: string; message?: string }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  const working = await getSiteIdeProvider(site);

  if (site.sourceType === "file") {
    const paths = await collectAllFiles(working).catch(() => [] as string[]);
    return Response.json({
      ok: true,
      fileCount: paths.length,
      perFile: paths.map((p) => ({ path: p, ok: true })),
      downloadUrl: `/api/websites/${site.id}/download?projectId=${site.projectId}`,
      mock: false,
    });
  }

  const remote = await getSiteRemote(site).catch((err: unknown) => ({
    error: err instanceof Error ? err.message : "Cannot reach remote",
  }));
  if (remote && "error" in remote) {
    return Response.json({ error: remote.error }, { status: 502 });
  }
  if (!remote) return Response.json({ error: "No remote configured" }, { status: 400 });

  const message =
    (body?.message ?? "").trim().slice(0, 200) || `Marketr deploy: ${site.name}`;

  try {
    const paths = await collectAllFiles(working);
    const files: { path: string; content: string }[] = [];
    for (const p of paths) {
      const { content } = await working.readFile(p);
      files.push({ path: p, content });
    }

    if (remote.kind === "github") {
      const result = await remote.connector.pushFiles(files, message);
      return Response.json({
        ok: true,
        fileCount: result.files.length,
        perFile: result.files,
        commitSha: result.sha,
        mock: result.mock === true,
      });
    }

    // SFTP: per-file writes over the milestone-6 provider.
    const perFile: { path: string; ok: boolean; error?: string }[] = [];
    for (const f of files) {
      try {
        await remote.provider.writeFile(f.path, f.content);
        perFile.push({ path: f.path, ok: true });
      } catch (err) {
        perFile.push({
          path: f.path,
          ok: false,
          error: err instanceof Error ? err.message : "Write failed",
        });
      }
    }
    const failed = perFile.filter((f) => !f.ok);
    return Response.json({
      ok: failed.length === 0,
      fileCount: perFile.length,
      perFile,
      mock: !remote.provider.isLive,
      ...(failed.length > 0 ? { error: `${failed.length} file(s) failed to upload` } : {}),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Deploy failed" },
      { status: 502 },
    );
  }
}
