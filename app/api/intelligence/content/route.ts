// Marketr — Phase 13B: content memory history.
// GET /api/intelligence/content?workspaceId=…[&kind=blog_post][&limit=50]
// The "we already ran this angle" retrieval for the UI.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess } from "@/lib/route-utils";
import { listContentRecords } from "@/lib/intelligence/company/content-record";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const access = await requireWorkspaceAccess(
    user.id,
    workspaceIdFrom(req),
    "viewer",
  );
  if ("error" in access) return access.error;

  const qp = req.nextUrl.searchParams;
  const records = await listContentRecords(access.workspaceId, {
    kind: qp.get("kind") ?? undefined,
    limit: qp.get("limit") ? Number(qp.get("limit")) : undefined,
  });
  return Response.json({ records });
}
