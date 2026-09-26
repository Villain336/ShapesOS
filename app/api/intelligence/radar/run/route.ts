// Marketr — Platform-change radar: manual sweep.
// POST /api/intelligence/radar/run — same gate as cron routes: CRON_SECRET
// service call, or a signed-in session with editor+ on the workspace.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { runPlatformRadar } from "@/lib/intelligence/radar/sweep";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  if (gate.isCron) {
    return Response.json({ error: "Use /api/cron/platform-radar for the service sweep." }, { status: 400 });
  }
  const result = await runPlatformRadar(gate.workspaceId!);
  return Response.json({ ok: true, result });
}
