// Marketr — Connector Agent slice 3 API.
// POST /api/connector/paths — ranked intro paths to a target person or
// company (tenant → mutual contact → target), with warmth-product scores,
// freshness, and human-readable explanations composed from stored data
// only. Served from the per-tenant TTL cache unless { recompute: true }.
// Paths are computed, never persisted.
// Slice 5: { mode } per-query override — company targets are mode-scoped
// (LEADS: customer/prospect/partner; FUNDING: investor).
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";
import { ConnectorError } from "@/lib/connector/types";
import { CONNECTOR_MODES, type ConnectorMode } from "@/lib/connector/modes";
import { introErrorResponse } from "../intros/intro-error";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const body = (await readJson(req)) as {
      targetPersonId?: unknown;
      targetCompanyId?: unknown;
      limit?: unknown;
      recompute?: unknown;
      mode?: unknown;
    };

    const targetPersonId =
      typeof body.targetPersonId === "string" && body.targetPersonId.trim()
        ? body.targetPersonId.trim()
        : undefined;
    const targetCompanyId =
      typeof body.targetCompanyId === "string" && body.targetCompanyId.trim()
        ? body.targetCompanyId.trim()
        : undefined;
    let limit: number | undefined;
    if (body.limit != null) {
      const n = Number(body.limit);
      if (!Number.isInteger(n) || n < 1 || n > 25) {
        throw new ConnectorError("invalid_limit", "limit must be an integer from 1 to 25.");
      }
      limit = n;
    }
    let mode: ConnectorMode | undefined;
    if (body.mode != null && body.mode !== "") {
      const m = typeof body.mode === "string" ? body.mode.trim().toLowerCase() : "";
      if (!(CONNECTOR_MODES as readonly string[]).includes(m)) {
        throw new ConnectorError("invalid_mode", `mode must be one of: ${CONNECTOR_MODES.join(", ")}.`);
      }
      mode = m as ConnectorMode;
    }

    const store = new PrismaConnectorStore(prisma);
    const { result, cached, computedAt } = await store.computeIntroPaths(workspace.id, {
      targetPersonId,
      targetCompanyId,
      maxPaths: limit,
      recompute: body.recompute === true,
      mode,
    });
    return Response.json({ ...result, cached, computedAt });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}
