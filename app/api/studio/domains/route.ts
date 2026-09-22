// Marketr — studio API: Porkbun domain search, pricing, purchase (milestone 22).
// GET  /api/studio/domains/search?projectId=&domain= → availability (sequential, rate-limited)
// GET  /api/studio/domains/pricing?projectId=&tlds=com,io → TLD pricing
// GET  /api/studio/domains?projectId= → project domains
// POST /api/studio/domains { projectId, domain } → purchase preview (owner/admin, no charge)
// POST /api/studio/domains/purchase/confirm { projectId, confirmationToken, agreeToTerms, whoisPrivacy } (owner/admin)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createPorkbunPort, type PorkbunPort } from "@/lib/studio/porkbun";
import {
  checkDomainAvailability,
  confirmDomainPurchase,
  getPorkbunPort,
  getTldPricing,
  listStudioDomains,
  previewDomainPurchase,
  removeStudioDomain,
} from "@/lib/studio/service";
import { ownedProject, readJson, requireOwnerAdmin } from "../_lib";

async function workspacePort(workspaceId: string): Promise<{ port: PorkbunPort } | { response: Response }> {
  const port = await getPorkbunPort(prisma, workspaceId, (a, s) => createPorkbunPort({ apiKey: a, secretApiKey: s }));
  if (!port) {
    return {
      response: Response.json(
        { error: "No Porkbun API keys configured — add them in studio domain settings first." },
        { status: 400 },
      ),
    };
  }
  return { port };
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const project = await ownedProject(user.id, params.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const rows = await listStudioDomains(prisma, project.id);
  return Response.json({
    domains: rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      tld: r.tld,
      status: r.status,
      priceUsd: r.priceUsd != null ? Number(r.priceUsd) : null,
      orderId: r.orderId,
      whoisPrivacy: r.whoisPrivacy,
      purchasedAt: r.purchasedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      nameServers: r.nameServers ? (JSON.parse(r.nameServers) as string[]) : [],
      errorDetail: r.errorDetail,
    })),
  });
}

export async function POST(req: Request) {
  // Step 1 of the purchase wizard: preview (no charge).
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireOwnerAdmin(user.id, project.id);
  if (denied) return denied;
  const ported = await workspacePort(project.workspaceId);
  if ("response" in ported) return ported.response;
  try {
    const preview = await previewDomainPurchase(
      prisma,
      project.workspaceId,
      project.id,
      ported.port,
      String(body.domain ?? ""),
    );
    return Response.json({ preview });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Purchase preview failed." },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireOwnerAdmin(user.id, project.id);
  if (denied) return denied;
  try {
    await removeStudioDomain(prisma, project.workspaceId, project.id, String(body.domainId ?? ""), "user");
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to remove domain record." },
      { status: 400 },
    );
  }
}

export { checkDomainAvailability as _check, getTldPricing as _pricing, confirmDomainPurchase as _confirm };
