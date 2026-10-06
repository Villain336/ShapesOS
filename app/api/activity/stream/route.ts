// ShapesOS — Phase 18.2 (WS=content): the Activity Monitor, live (SSE).
// GET /api/activity/stream → text/event-stream
//   event: snapshot  data: { processes, health }   on connect, then whenever
//                    the processes change (polled every 2 s; the health panel
//                    every 15 s)
//   event: reconnect (the shared helper's drain / the 10-minute cap) — the
//                    browser reconnects and gets a fresh snapshot
// Access: same as GET /api/activity (any member; admin-only health rows).
// The shared SSE helper (lib/http/sse.ts): retry, 15 s heartbeats, drain.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { sseResponse, sseSleep } from "@/lib/http/sse";
import { loadProcesses, loadSystemHealth } from "@/lib/aos/activity.server";

export const dynamic = "force-dynamic";

const PROCESS_POLL_MS = 2_000;
const HEALTH_EVERY_MS = 15_000;
const MAX_STREAM_MS = 10 * 60_000;

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const m = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!m) return forbidden();
  const viewer = { userId: user.id, isAdmin: roleAtLeast(m.role, "admin") };
  return sseResponse(async (ch) => {
    const end = Date.now() + MAX_STREAM_MS;
    let lastProcesses = "";
    let health = await loadSystemHealth(workspace.id, viewer).catch(() => null);
    let healthAt = Date.now();
    while (!ch.closed && Date.now() < end) {
      const processes = await loadProcesses(workspace.id, viewer).catch(() => null);
      if (ch.closed) return;
      if (Date.now() - healthAt >= HEALTH_EVERY_MS) {
        health = (await loadSystemHealth(workspace.id, viewer).catch(() => null)) ?? health;
        healthAt = Date.now();
        if (processes) ch.send("snapshot", { processes, health });
        lastProcesses = JSON.stringify(processes);
      } else if (processes) {
        const json = JSON.stringify(processes);
        if (json !== lastProcesses) {
          lastProcesses = json;
          ch.send("snapshot", { processes, health });
        }
      }
      await sseSleep(ch, PROCESS_POLL_MS);
    }
    if (!ch.closed) ch.reconnect();
  });
}
