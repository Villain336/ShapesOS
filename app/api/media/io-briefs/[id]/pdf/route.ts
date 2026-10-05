// Marketr — GET /api/media/io-briefs/[id]/pdf (B3). Serves the IO-brief PDF.

import type { NextRequest } from "next/server";
import { mediaGuard } from "../../../_lib";
import { SqlIoBriefStore, buyingTablesReady } from "@/lib/media/buying-store";
import { readIoBriefPdf } from "@/lib/media/io-briefs";

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
  const store = new SqlIoBriefStore();
  const brief = await store.get(id, gate.workspaceId);
  if (!brief || !brief.briefPdfUrl) return new Response("Brief not found", { status: 404 });
  // Shared blob store (deploy PR); older briefs resolve by their legacy key.
  const bytes = await readIoBriefPdf(gate.workspaceId, brief.id).catch(() => null);
  if (!bytes) return new Response("Brief PDF not found in storage", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="io-brief-${brief.id}.pdf"`,
    },
  });
}
