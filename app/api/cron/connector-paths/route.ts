// Marketr — Connector Agent slice 3 scheduled recompute.
// POST /api/cron/connector-paths
//
// Auth: Authorization: Bearer <CRON_SECRET> — same pattern as
// /api/cron/connector-refresh. Schedule alongside the other cron jobs
// (daily is plenty; paths also recompute on demand with a TTL cache).
//
// Bounded: only tenants with connector people are visited (max 200 per
// run), and each tenant's sweep warms at most 25 candidate targets with
// 10 paths each. IntroPaths are computed into the per-tenant cache —
// never persisted across tenants.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";

export const dynamic = "force-dynamic";

const MAX_TENANTS_PER_RUN = 200;

function cronAuthorized(req: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenants = await prisma.connectorPerson.groupBy({
    by: ["workspaceId"],
    orderBy: { workspaceId: "asc" },
    take: MAX_TENANTS_PER_RUN,
  });

  const store = new PrismaConnectorStore(prisma);
  let tenantsWarmed = 0;
  let targetsWarmed = 0;
  let pathsCached = 0;
  const errors: { workspaceId: string; error: string }[] = [];

  for (const t of tenants) {
    try {
      const r = await store.warmPathCache(t.workspaceId);
      tenantsWarmed += 1;
      targetsWarmed += r.targetsWarmed;
      pathsCached += r.pathsCached;
    } catch (err) {
      errors.push({
        workspaceId: t.workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({
    tenants: tenants.length,
    tenantsWarmed,
    targetsWarmed,
    pathsCached,
    errors,
  });
}
