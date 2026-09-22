// Marketr — studio API: TLD pricing from Porkbun (milestone 22).
// GET /api/studio/domains/pricing?projectId=&tlds=com,io,xyz

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createPorkbunPort } from "@/lib/studio/porkbun";
import { getPorkbunPort, getTldPricing } from "@/lib/studio/service";
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
  const tlds = (params.get("tlds") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  try {
    const pricing = await getTldPricing(port, tlds.length > 0 ? tlds : undefined);
    return Response.json({ pricing });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Pricing lookup failed." },
      { status: 502 },
    );
  }
}
