// ShapesOS — POST /api/cron/dev-sandbox-reconcile: durable scheduling for
// the dev-sandbox reconciler (in-product browser "Dev preview" v1).
//
// Auth: the shared cronGate (Bearer CRON_SECRET for the scheduler, or a
// signed-in editor for their own workspace). Schedule every 5 minutes.
// The reconciler flips provider-auto-paused rows to paused, destroys rows
// whose provider sandbox is gone, and enforces the per-row created-at
// ceiling (test-bounded rows keep their tighter test ceiling). The
// provider-side backstop is the running TTL itself: a sandbox stops even
// if this route never fires; this route keeps the DB honest and stops
// pathological always-active sandboxes at their absolute ceiling.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { prisma } from "@/lib/prisma";
import { reconcileDevSandboxes } from "@/lib/sandbox/dev-sandbox";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const workspaces = gate.isCron
    ? await prisma.workspace.findMany({ select: { id: true } })
    : [{ id: gate.workspaceId! }];
  const results: { workspaceId: string; markedPaused: number; ceilingDestroyed: number; error?: string }[] = [];
  for (const ws of workspaces) {
    try {
      const r = await reconcileDevSandboxes(ws.id);
      if (r.markedPaused || r.ceilingDestroyed) results.push({ workspaceId: ws.id, ...r });
    } catch (err) {
      results.push({ workspaceId: ws.id, markedPaused: 0, ceilingDestroyed: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return Response.json({ ok: true, reconciled: results });
}
