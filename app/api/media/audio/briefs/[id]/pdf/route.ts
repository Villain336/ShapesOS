// Marketr — GET /api/media/audio/briefs/[id]/pdf (B2). Serves the brief PDF.

import type { NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { mediaGuard } from "../../../../_lib";
import { SqlAudioBuyStore, buyingTablesReady } from "@/lib/media/buying-store";
import { audioBriefStorageDir } from "@/lib/media/audio";

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
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path.join(audioBriefStorageDir(), `${buy.id}.pdf`));
  } catch {
    return new Response("Brief PDF not found on disk", { status: 404 });
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="audio-brief-${buy.id}.pdf"`,
    },
  });
}
