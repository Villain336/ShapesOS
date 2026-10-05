// Marketr — replay ingest + session listing (Phase 12 "embeds", rrweb).
// POST /api/s/[token]/replay — append an event batch (public, token-bound).
// GET  /api/s/[token]/replay — list sessions (workspace-authenticated).
// The POST path uses the same no-oracle share resolution as the share page:
// unknown / revoked / expired / non-opt-in tokens all 404 identically and
// the body is sanitized before storage.

import { z } from "zod";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import {
  appendReplayEvents,
  listReplaySessions,
  resolveActiveShare,
  sanitizeReplayBatch,
} from "@/lib/integrations/replay";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const BatchSchema = z.object({
  events: z.unknown(),
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const share = await resolveActiveShare(token);
  if (!share) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BatchSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input" }, { status: 400 });
  }
  const events = sanitizeReplayBatch(parsed.data.events);
  if (events.length === 0) {
    return Response.json({ error: "Empty event batch." }, { status: 400 });
  }
  try {
    const result = await appendReplayEvents(
      share.id,
      share.workspaceId,
      share.designId,
      events,
    );
    return Response.json(result, { status: 202 });
  } catch (e) {
    return errorResponse(e, "POST /api/s/[token]/replay");
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  // Tenant-scoped: the session list is only visible to the workspace that
  // owns the share. The token itself is never usable as an oracle — we
  // resolve the share and then check workspace ownership.
  const share = await resolveActiveShare(token);
  if (!share || share.workspaceId !== workspace.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const sessions = await listReplaySessions(share.id);
  return Response.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
    })),
  });
}
