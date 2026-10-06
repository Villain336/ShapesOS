// Marketr — GET /api/media/audio/briefs/[id]/pdf (B2). Serves the brief PDF.

import type { NextRequest } from "next/server";
import { mediaGuard } from "../../../../_lib";
import { SqlAudioBuyStore, buyingTablesReady } from "@/lib/media/buying-store";
import { readAudioBriefPdf } from "@/lib/media/audio";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  if (!(await buyingTablesReady())) {
    return new Response("Phase 5 buying tables are not yet migrated.", { status: 503 });
  }
  const store = new SqlAudioBuyStore();
  const buy = await store.get(id, gate.workspaceId);
  if (!buy || !buy.briefUrl) return new Response("Brief not found", { status: 404 });
  // Shared blob store (deploy PR); older briefs resolve by their legacy key.
  const bytes = await readAudioBriefPdf(gate.workspaceId, buy.id).catch(() => null);
  if (!bytes) return new Response("Brief PDF not found in storage", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="audio-brief-${buy.id}.pdf"`,
    },
  });
}
