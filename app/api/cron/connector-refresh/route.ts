// Marketr — connector token refresh cron (milestone 21).
// POST /api/cron/connector-refresh
//
// Auth: Authorization: Bearer <CRON_SECRET> — same pattern as
// /api/cron/reports. Schedule it alongside the other cron jobs (every
// 5–15 minutes is fine; refreshes are idempotent).
//
// The sweep itself (which connections are due, and why API keys are never
// "stale") lives in lib/vault/refresh-due.ts.

import type { NextRequest } from "next/server";
import { refreshDueConnections } from "@/lib/vault/refresh-due";
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
  return Response.json(await refreshDueConnections());
}
