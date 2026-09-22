// Marketr — studio API: confirm a domain purchase (milestone 22).
// POST /api/studio/domains/purchase/confirm { projectId, confirmationToken, agreeToTerms, whoisPrivacy }
// Owner/admin only. The confirmation token is single-use; availability and
// price are re-checked server-side before Porkbun is charged.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createPorkbunPort } from "@/lib/studio/porkbun";
import { confirmDomainPurchase, getPorkbunPort } from "@/lib/studio/service";
import { ownedProject, readJson, requireOwnerAdmin } from "../../../_lib";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireOwnerAdmin(user.id, project.id);
  if (denied) return denied;
  const port = await getPorkbunPort(prisma, project.workspaceId, (a, s) =>
    createPorkbunPort({ apiKey: a, secretApiKey: s }),
  );
  if (!port) {
    return Response.json(
      { error: "No Porkbun API keys configured — add them in studio domain settings first." },
      { status: 400 },
    );
  }
  try {
    const result = await confirmDomainPurchase(prisma, project.workspaceId, project.id, port, {
      confirmationToken: String(body.confirmationToken ?? ""),
      agreeToTerms: body.agreeToTerms === true,
      whoisPrivacy: body.whoisPrivacy !== false,
    });
    return Response.json({ purchase: result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Purchase failed." },
      { status: 400 },
    );
  }
}
