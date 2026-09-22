// Marketr — studio API: domain availability search (milestone 22).
// GET /api/studio/domains/search?projectId=&domain=
// Porkbun rate-limits availability checks (~1/10s) — this endpoint checks one
// domain per request, never in parallel.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createPorkbunPort } from "@/lib/studio/porkbun";
import { checkDomainAvailability, getPorkbunPort } from "@/lib/studio/service";
import { ownedProject } from "../../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const project = await ownedProject(user.id, params.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
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
    const result = await checkDomainAvailability(port, params.get("domain") ?? "");
    return Response.json({ availability: result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Availability check failed." },
      { status: 400 },
    );
  }
}
