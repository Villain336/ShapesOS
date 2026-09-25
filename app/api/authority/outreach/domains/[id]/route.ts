// Marketr — O1 /api/authority/outreach/domains/:id
// GET   → single sending domain with checklist evaluation (viewer+)
// PATCH → update DNS/warmup verification state (editor+)

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { updateDomainSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import { evaluateDomain, warmupDays } from "@/lib/authority/outreach";
import { outreachStores } from "@/app/api/authority/outreach/_stores";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ domain: null, tablesReady: false });
  }
  const { id } = await params;
  const stores = outreachStores();
  const d = await stores.domains.get(id, gate.workspaceId);
  if (!d) return Response.json({ error: "Sending domain not found in workspace." }, { status: 404 });
  const { failures, ready } = evaluateDomain(d);
  return Response.json({
    domain: d,
    warmupDays: warmupDays({ warmupStartedAt: d.warmupStartedAt }),
    checklistPassed: ready,
    checklistFailures: failures,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json(
      { error: "Authority tables not provisioned yet (migration pending)." },
      { status: 503 },
    );
  }
  const { id } = await params;
  const parsed = updateDomainSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid domain update", parsed.error.issues);
  const stores = outreachStores();
  try {
    const domain = await stores.domains.update(id, gate.workspaceId, {
      ...(parsed.data.spfOk !== undefined ? { spfOk: parsed.data.spfOk } : {}),
      ...(parsed.data.dkimOk !== undefined ? { dkimOk: parsed.data.dkimOk } : {}),
      ...(parsed.data.dmarcPolicy !== undefined ? { dmarcPolicy: parsed.data.dmarcPolicy } : {}),
      ...(parsed.data.trackingCnameOk !== undefined ? { trackingCnameOk: parsed.data.trackingCnameOk } : {}),
      ...(parsed.data.warmupStartedAt !== undefined
        ? { warmupStartedAt: parsed.data.warmupStartedAt ? new Date(parsed.data.warmupStartedAt) : null }
        : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    });
    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "sending_domain_updated",
      entityType: "sending_domain",
      entityId: domain.id,
      detail: { status: domain.status },
    });
    return Response.json({ domain });
  } catch (err) {
    return safetyError(err);
  }
}
