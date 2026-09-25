// Marketr — O1 /api/authority/outreach/domains
// Sending-domain management. Secondary domains only for cold sending —
// primary domains and Gmail free accounts are hard-blocked at dispatch by
// the depth-3 enablement checklist (see guards.depth3Checklist).
// GET  → list domains with live checklist evaluation (viewer+)
// POST → register a sending domain (editor+)

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { sendingDomainSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import { evaluateDomain, warmupDays } from "@/lib/authority/outreach";
import { outreachStores } from "@/app/api/authority/outreach/_stores";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ domains: [], tablesReady: false });
  }
  const stores = outreachStores();
  const domains = await stores.domains.list(gate.workspaceId);
  return Response.json({
    domains: domains.map((d) => {
      const { failures, ready } = evaluateDomain(d);
      return {
        id: d.id,
        domain: d.domain,
        isPrimary: d.isPrimary,
        status: d.status,
        spfOk: d.spfOk,
        dkimOk: d.dkimOk,
        dmarcPolicy: d.dmarcPolicy,
        trackingCnameOk: d.trackingCnameOk,
        warmupStartedAt: d.warmupStartedAt,
        warmupDays: warmupDays({ warmupStartedAt: d.warmupStartedAt }),
        checklistPassed: ready,
        checklistFailures: failures,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json(
      { error: "Authority tables not provisioned yet (migration pending)." },
      { status: 503 },
    );
  }
  const parsed = sendingDomainSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid domain input", parsed.error.issues);
  const stores = outreachStores();
  try {
    const existing = await stores.domains.getByDomain(gate.workspaceId, parsed.data.domain);
    if (existing) return Response.json({ error: "Domain is already registered in this workspace." }, { status: 409 });
    const domain = await stores.domains.create(gate.workspaceId, {
      domain: parsed.data.domain,
      isPrimary: parsed.data.isPrimary,
      spfOk: parsed.data.spfOk,
      dkimOk: parsed.data.dkimOk,
      dmarcPolicy: parsed.data.dmarcPolicy ?? null,
      trackingCnameOk: parsed.data.trackingCnameOk,
      warmupStartedAt: parsed.data.warmupStartedAt ? new Date(parsed.data.warmupStartedAt) : null,
    });
    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "sending_domain_registered",
      entityType: "sending_domain",
      entityId: domain.id,
      detail: { domain: domain.domain, isPrimary: domain.isPrimary },
    });
    return Response.json({ domain }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}
