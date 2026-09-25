// Marketr — O1 GET /api/authority/outreach/deliverability (viewer+)
// Postmaster-style deliverability per sending domain: reputation, spam rate
// vs ceiling, real bounce rate vs circuit-breaker, warmup progress, and the
// depth-3 checklist failures. Query: ?domainId= (single domain) or all.

import type { NextRequest } from "next/server";
import { authorityGuard } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { deliverabilityForDomain, deliverabilityForWorkspace } from "@/lib/authority/outreach";
import { outreachStores } from "@/app/api/authority/outreach/_stores";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ domains: [], tablesReady: false });
  }
  const stores = outreachStores();
  const deps = {
    domains: stores.domains,
    sequences: stores.sequences,
    campaigns: { list: (w: string) => stores.campaigns.list(w) },
  };
  const domainId = new URL(req.url).searchParams.get("domainId") ?? undefined;
  if (domainId) {
    const domain = await stores.domains.get(domainId, gate.workspaceId);
    if (!domain) return Response.json({ error: "Sending domain not found in workspace." }, { status: 404 });
    const report = await deliverabilityForDomain(deps, gate.workspaceId, domain);
    return Response.json({ domains: [report] });
  }
  const reports = await deliverabilityForWorkspace(deps, gate.workspaceId);
  return Response.json({ domains: reports });
}
