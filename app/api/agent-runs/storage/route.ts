// Marketr — Phase 16 slice 8: recording storage accounting API.
// GET /api/agent-runs/storage?workspaceId=
//   → per-workspace rollup: total/video/trace bytes, recording count,
//     pinned count, purged-video count.
// PATCH /api/agent-runs/storage { workspaceId, runId, pinned }
//   → pin/unpin a recording (pinned videos survive the retention sweep).
// Reads+writes: admin+. Storage numbers feed billing-adjacent copy —
// viewers don't get the ledger, same rule as /api/usage/summary.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess, workspaceIdFrom, badRequest } from "@/lib/route-utils";
import { getRecordingStorage, setRecordingPinned } from "@/lib/agents/runs/retention";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;

  const storage = await getRecordingStorage(access.workspaceId);
  return Response.json({ ok: true, storage });
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { workspaceId?: unknown; runId?: unknown; pinned?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body), "admin");
  if ("error" in access) return access.error;
  if (typeof body.runId !== "string" || !body.runId) return badRequest("runId is required");
  if (typeof body.pinned !== "boolean") return badRequest("pinned must be a boolean");

  const recording = await setRecordingPinned(access.workspaceId, body.runId, body.pinned).catch(
    () => null,
  );
  if (!recording) return Response.json({ error: "Recording not found" }, { status: 404 });
  return Response.json({ ok: true, runId: recording.runId, pinned: recording.pinned });
}
