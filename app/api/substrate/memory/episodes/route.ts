// Marketr — GET /api/substrate/memory/episodes (Phase 8 G3).
// Episodic log: query params `type` (run|session|sync|agent_call) and
// `limit` (≤200). Immutable — no write endpoints. Actor filtering happens
// client-side after the scoped fetch.

import type { NextRequest } from "next/server";
import { memoryGuard, badRequest } from "../_lib";
import { listEpisodes } from "@/lib/substrate/memory/write";

export const dynamic = "force-dynamic";

const EPISODE_TYPES = ["run", "session", "sync", "agent_call"] as const;

export async function GET(req: NextRequest) {
  const gate = await memoryGuard(req, "viewer");
  if (gate instanceof Response) return gate;
  const p = req.nextUrl.searchParams;
  const type = p.get("type");
  const limit = Math.min(Number(p.get("limit") ?? 50) || 50, 200);
  if (type && !(EPISODE_TYPES as readonly string[]).includes(type)) {
    return badRequest(`unknown episode type: ${type}`);
  }
  const episodes = await listEpisodes(gate.workspaceId, {
    type: type ? (type as (typeof EPISODE_TYPES)[number]) : undefined,
    limit,
  });
  return Response.json({ episodes });
}
