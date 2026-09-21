// Marketr — site file browsing API (milestone 7).
// GET /api/websites/[id]/files?projectId=…&path=/… → { entries, path }
// Operates on the site's local working copy (synced from GitHub/SFTP via
// /sync). Paths are sanitized server-side; ".." is rejected.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { sanitizePath } from "@/lib/sitefiles/paths";
import { getSiteIdeProvider, ownedSite } from "@/lib/connectors/source";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const site = await ownedSite(user.id, sp.get("projectId"), id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  let path: string;
  try {
    path = sanitizePath(sp.get("path") ?? "/");
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid path" },
      { status: 400 },
    );
  }

  try {
    const entries = await (await getSiteIdeProvider(site)).listDir(path);
    return Response.json({ entries, path });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Cannot list directory" },
      { status: 500 },
    );
  }
}
