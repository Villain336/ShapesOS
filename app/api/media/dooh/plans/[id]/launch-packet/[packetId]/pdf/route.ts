// Marketr — GET /api/media/dooh/plans/[id]/launch-packet/[packetId]/pdf (B1).
// Serves the compiled launch-packet PDF bytes (viewer+).

import type { NextRequest } from "next/server";
import { mediaGuard } from "../../../../../../_lib";
import { SqlDoohPlanStore, SqlLaunchPacketStore, buyingTablesReady } from "@/lib/media/buying-store";
import { readLaunchPacketPdf } from "@/lib/media/launch-packet";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; packetId: string }> },
) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id, packetId } = await params;
  if (!(await buyingTablesReady())) {
    return new Response("Phase 5 buying tables are not yet migrated.", { status: 503 });
  }
  const planStore = new SqlDoohPlanStore();
  const plan = await planStore.get(id, gate.workspaceId);
  if (!plan) return new Response("Plan not found", { status: 404 });
  const packetStore = new SqlLaunchPacketStore();
  const packets = await packetStore.listForPlan(id, gate.workspaceId);
  const packet = packets.find((p) => p.id === packetId);
  if (!packet) return new Response("Packet not found", { status: 404 });

  // Shared blob store (deploy PR); older packets resolve by their legacy key.
  const bytes = await readLaunchPacketPdf(gate.workspaceId, plan.id, packet.version).catch(() => null);
  if (!bytes) return new Response("Packet PDF not found in storage", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="launch-packet-${plan.id}-v${packet.version}.pdf"`,
      "X-Packet-Sha256": packet.packetSha256,
    },
  });
}
