// Marketr — studio creatives API shared helpers (Phase 4, T2).
// Every route: guardWorkspace + workspace-scoped queries. CreativeHttpError
// maps to its own status (notably 409 for the Canva Enterprise gate).

import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { createCanvaPort, type CanvaPort } from "@/lib/studio/canva";
import {
  CreativeHttpError,
  requireCanvaEnterprise,
} from "@/lib/studio/creatives";
import { getCanvaStatus } from "@/lib/studio/service";
import { canvaClientConfig } from "../_lib";

export { guardWorkspace, httpErrorResponse, readJson };

export function creativeErrorResponse(e: unknown) {
  if (e instanceof CreativeHttpError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return httpErrorResponse(e);
}

export function productionCanvaPort(): CanvaPort {
  return createCanvaPort();
}

export function canvaClient() {
  return canvaClientConfig();
}

/**
 * Enterprise gate for brand-template flows (list templates, autofill): the
 * connected account must have granted brand-template scopes. Clean 409 with
 * "requires Canva Enterprise" — never faked.
 */
export async function assertCanvaEnterprise(workspaceId: string): Promise<void> {
  const status = await getCanvaStatus(prisma, workspaceId);
  if (!status.connected) {
    throw new CreativeHttpError(409, "No Canva account connected — connect Canva in the studio first.");
  }
  requireCanvaEnterprise(status.scopes);
}
