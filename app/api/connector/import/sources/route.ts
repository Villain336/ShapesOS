// Marketr — Connector Agent slice 2 API.
// GET /api/connector/import/sources — per-source import status: consent
// grant, OS connector connection, last import batch. Drives the import
// sources UI (connect → consent → exclude → run).
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { getImportSourcesStatus } from "@/lib/connector/import-engine";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const sources = await getImportSourcesStatus(workspace.id);
    return Response.json({ sources, workspaceId: workspace.id });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
