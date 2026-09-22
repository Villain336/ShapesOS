// Marketr — connector token refresh cron (milestone 21).
// POST /api/cron/connector-refresh
//
// Auth: Authorization: Bearer <CRON_SECRET> — same pattern as
// /api/cron/reports. Schedule it alongside the other cron jobs (every
// 5–15 minutes is fine; refreshes are idempotent).
//
// Due connections: status=active with a credential whose expiresAt is
// within 15 minutes (or already passed), OR status=active with a
// credential that has no expiresAt and a lastRefreshAt older than 24h
// (stale — some providers omit expires_in).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { refreshConnection } from "@/lib/vault/refresh";

export const dynamic = "force-dynamic";

const REFRESH_WINDOW_MS = 15 * 60 * 1000;
const STALE_REFRESH_MS = 24 * 60 * 60 * 1000;

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

  const now = Date.now();
  const due = await prisma.connectorConnection.findMany({
    where: {
      status: "active",
      OR: [
        { credential: { expiresAt: { lte: new Date(now + REFRESH_WINDOW_MS) } } },
        {
          credential: { expiresAt: null },
          OR: [
            { lastRefreshAt: null },
            { lastRefreshAt: { lte: new Date(now - STALE_REFRESH_MS) } },
          ],
        },
      ],
    },
    select: { id: true, connectorKey: true },
  });

  let refreshed = 0;
  let needsReauth = 0;
  const errors: { connectionId: string; error: string }[] = [];
  for (const conn of due) {
    try {
      const result = await refreshConnection(conn.id);
      if (result === "refreshed") refreshed += 1;
      else needsReauth += 1;
    } catch (err) {
      errors.push({
        connectionId: conn.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({
    checked: due.length,
    refreshed,
    needsReauth,
    errors,
  });
}
