// ShapesOS — Phase 18.3 (WS=flow): POST /api/cron/snapshots — the hourly
// Time Machine sweep (lib/cron/jobs.ts "snapshots").
//   Cron (Authorization: Bearer <CRON_SECRET>): every workspace whose
//     schedule (Settings → Time Machine: daily / weekly) is due gets a
//     snapshot, then retention prunes the oldest (lib/timemachine/snapshots.ts).
//   A signed-in session (cronGate: editor+) only sweeps its own workspace,
//     and only when ITS schedule is due.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { createSnapshot, getSnapshotSettings, listSnapshots, runDueSnapshots, snapshotDue } from "@/lib/timemachine/snapshots";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  if (gate.isCron) return Response.json(await runDueSnapshots());
  const ws = gate.workspaceId!;
  const settings = await getSnapshotSettings(ws);
  const last = (await listSnapshots(ws)).find((s) => s.status !== "failed");
  if (!snapshotDue(settings.schedule, last ? new Date(last.createdAt) : null, new Date())) return Response.json({ taken: [], failed: [] });
  try {
    await createSnapshot({ workspaceId: ws, userId: "system:time-machine", trigger: "scheduled" });
    return Response.json({ taken: [ws], failed: [] });
  } catch (err) {
    return Response.json({ taken: [], failed: [{ workspaceId: ws, error: err instanceof Error ? err.message : String(err) }] });
  }
}
