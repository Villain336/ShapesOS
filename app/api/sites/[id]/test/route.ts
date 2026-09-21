// Marketr — connection test API (milestone 6).
// POST /api/sites/[id]/test?projectId=… → { ok, message }
// Runs server-side; updates lastTestedAt / lastTestOk.

import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getSiteFileProvider, publicConnection } from "@/lib/sitefiles";
import { ownedConnection } from "@/lib/sitefiles/api";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const connection = await ownedConnection(
    user.id,
    req.nextUrl.searchParams.get("projectId"),
    id,
  );
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }
  if (!(await requireProjectRole(user.id, connection.projectId, "admin"))) return forbidden();

  let result: { ok: boolean; message: string };
  try {
    result = await getSiteFileProvider(connection).test();
  } catch (err) {
    result = {
      ok: false,
      message: err instanceof Error ? err.message : "Test failed",
    };
  }

  const updated = await prisma.siteConnection.update({
    where: { id: connection.id },
    data: { lastTestedAt: new Date(), lastTestOk: result.ok },
  });

  return Response.json({ ...result, connection: publicConnection(updated) });
}
