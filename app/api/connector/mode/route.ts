// Marketr — Connector Agent slice 5 API.
// GET /api/connector/mode — the tenant's connector mode (viewer role).
// PUT /api/connector/mode — set the tenant's mode (editor role).
//   { mode: "leads" | "funding" } — the LEADS/FUNDING switch on
//   /dashboard/connector. Per-query/per-proposal mode overrides ride
//   along on those requests; this is the tenant-level default.
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";
import { ConnectorError } from "@/lib/connector/types";
import { CONNECTOR_MODES } from "@/lib/connector/modes";
import { introErrorResponse } from "../intros/intro-error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaConnectorStore(prisma);
    const setting = await store.getMode(workspace.id);
    return Response.json(setting);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function PUT(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { mode?: unknown };
    const mode =
      typeof body.mode === "string" ? body.mode.trim().toLowerCase() : "";
    if (!(CONNECTOR_MODES as readonly string[]).includes(mode)) {
      throw new ConnectorError(
        "invalid_mode",
        `mode must be one of: ${CONNECTOR_MODES.join(", ")}.`,
      );
    }
    const store = new PrismaConnectorStore(prisma);
    const setting = await store.setMode(
      workspace.id,
      mode as (typeof CONNECTOR_MODES)[number],
    );
    return Response.json(setting);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}
