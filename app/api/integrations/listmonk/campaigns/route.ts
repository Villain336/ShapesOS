// Marketr — Listmonk sidecar: campaigns (Phase 12).
// GET  /api/integrations/listmonk/campaigns?status=&query= → { campaigns }
// POST /api/integrations/listmonk/campaigns { name, subject, listIds, body, templateId?, fromEmail?, contentType? }
//   → creates a DRAFT. Sends are a separate, explicit call.

import { z } from "zod";
import { guardWorkspace, readJson, sidecarError } from "../../_lib";
import { createListmonkCampaign, listmonkCampaigns } from "@/lib/integrations/listmonk";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(128),
  subject: z.string().trim().min(1).max(320),
  listIds: z.array(z.number().int().positive()).min(1).max(50),
  body: z.string().trim().min(1).max(500_000),
  templateId: z.number().int().positive().optional(),
  fromEmail: z.string().trim().max(320).optional(),
  contentType: z.enum(["html", "richtext", "markdown", "plain"]).optional(),
});

async function handleGET(req: Request) {
  try {
    await guardWorkspace();
    const sp = new URL(req.url).searchParams;
    return Response.json({
      campaigns: await listmonkCampaigns({
        status: sp.get("status") ?? undefined,
        query: sp.get("query") ?? undefined,
      }),
    });
  } catch (e) {
    return sidecarError(e);
  }
}

async function handlePOST(req: Request) {
  try {
    await guardWorkspace({ editor: true });
    const parsed = CreateSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    return Response.json(
      { campaign: await createListmonkCampaign(parsed.data) },
      { status: 201 },
    );
  } catch (e) {
    return sidecarError(e);
  }
}

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const GET = sidecarScoped(handleGET);
export const POST = sidecarScoped(handlePOST);
