// Marketr — remote file browsing API (milestone 6).
// GET /api/sites/[id]/files?projectId=…&path=/… → { entries, path }
// Paths are sanitized server-side; ".." is rejected.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { getSiteFileProvider } from "@/lib/sitefiles";
import { sanitizePath } from "@/lib/sitefiles/paths";
import { ownedConnection } from "@/lib/sitefiles/api";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const connection = await ownedConnection(user.id, sp.get("projectId"), id);
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }

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
    const entries = await getSiteFileProvider(connection).listDir(path);
    return Response.json({ entries, path });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Cannot list directory" },
      { status: 500 },
    );
  }
}
