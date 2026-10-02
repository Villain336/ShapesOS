// Marketr — Connector Agent slice 1 API.
// POST /api/connector/touch — record one interaction touch with a person
// (editor role). Updates the interaction signals and recomputes warmth
// from them in the same call.
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";
import { ConnectorError, type TouchInput } from "@/lib/connector/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as TouchInput;
    const store = new PrismaConnectorStore(prisma);
    const rel = await store.recordTouch(workspace.id, body);
    return Response.json(rel);
  } catch (e) {
    if (e instanceof ConnectorError) {
      const status = e.code === "person_not_found" ? 404 : 400;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}
