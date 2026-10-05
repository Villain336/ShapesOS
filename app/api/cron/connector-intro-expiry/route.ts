// Marketr — Connector Agent slice 4 expiry sweep cron.
// POST /api/cron/connector-intro-expiry
//
// Auth: Authorization: Bearer <CRON_SECRET> — same pattern as
// /api/cron/connector-paths. Schedule daily; unanswered proposals past
// their window (default 14 days) move to expired (terminal).
//
// Bounded: only workspaces with proposed introductions are visited.
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { PrismaIntroductionStore } from "@/lib/connector/introduction-store";
import { DEFAULT_INTRO_EXPIRY_DAYS } from "@/lib/connector/introductions";
import { bearerMatches } from "@/lib/security/constant-time";

export const dynamic = "force-dynamic";

function cronAuthorized(req: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return bearerMatches(header, secret);
}

export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  let expiryDays = DEFAULT_INTRO_EXPIRY_DAYS;
  try {
    const body = (await req.json()) as { expiryDays?: unknown };
    const n = Number(body.expiryDays);
    if (Number.isInteger(n) && n >= 1 && n <= 90) expiryDays = n;
  } catch {
    // No body — use the default window.
  }

  const workspaces = await prisma.connectorIntroduction.findMany({
    where: { status: "proposed" },
    select: { workspaceId: true },
    distinct: ["workspaceId"],
  });

  const store = new PrismaIntroductionStore(prisma);
  const now = new Date();
  let expired = 0;
  for (const { workspaceId } of workspaces) {
    const result = await store.sweepExpiredIntroductions(workspaceId, { expiryDays, now });
    expired += result.expired;
  }
  return Response.json({
    ok: true,
    workspaces: workspaces.length,
    expired,
    expiryDays,
  });
}
