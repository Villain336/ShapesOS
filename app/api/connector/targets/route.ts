// Marketr — Connector Agent slice 5 API.
// GET /api/connector/targets — mode-scoped intro targets (viewer role).
//   ?mode=leads|funding — overrides the tenant's mode setting for this
//   query. LEADS returns buyer/partner companies; FUNDING returns
//   investor companies PLUS the Funding/VC investor CRM (read-only —
//   the connector never duplicates investor data).
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";
import { ConnectorError } from "@/lib/connector/types";
import { CONNECTOR_MODES, type ConnectorMode } from "@/lib/connector/modes";
import { introErrorResponse } from "../intros/intro-error";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const url = new URL(req.url);
    const modeParam = url.searchParams.get("mode");
    let mode: ConnectorMode | undefined;
    if (modeParam) {
      const m = modeParam.trim().toLowerCase();
      if (!(CONNECTOR_MODES as readonly string[]).includes(m)) {
        throw new ConnectorError(
          "invalid_mode",
          `mode must be one of: ${CONNECTOR_MODES.join(", ")}.`,
        );
      }
      mode = m as ConnectorMode;
    }
    const store = new PrismaConnectorStore(prisma);
    const targets = await store.listTargets(workspace.id, mode);
    return Response.json(targets);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}
