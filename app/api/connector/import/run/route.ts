// Marketr — Connector Agent slice 2 API.
// POST /api/connector/import/run — run one provider import for a source
// (editor). Consent-gated: 403 no_consent when no consent grant exists.
// The batch records provenance (consentedBy/consentedAt from the grant)
// and the run stats; exclusions and the incremental cursor are enforced
// inside the engine.
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { runImport } from "@/lib/connector/import-engine";
import { ConnectorError, type ConnectorImportSource } from "@/lib/connector/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function connectorErrorResponse(e: ConnectorError) {
  const status =
    e.code === "no_consent"
      ? 403
      : e.code === "not_connected"
        ? 400
        : 400;
  return Response.json({ error: e.message, code: e.code }, { status });
}

export async function POST(req: Request) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { source?: unknown };
    const batch = await runImport({
      workspaceId: workspace.id,
      userId: user.id,
      source: body.source as ConnectorImportSource,
    });
    return Response.json(batch, { status: 201 });
  } catch (e) {
    if (e instanceof ConnectorError) return connectorErrorResponse(e);
    return httpErrorResponse(e);
  }
}
