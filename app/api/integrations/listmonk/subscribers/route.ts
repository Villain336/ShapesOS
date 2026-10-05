// Marketr — Listmonk sidecar: subscribers (Phase 12).
// GET  /api/integrations/listmonk/subscribers?query=&page= → { subscribers, total }
// POST /api/integrations/listmonk/subscribers { email, name?, listIds } → { subscriber }

import { z } from "zod";
import { guardWorkspace, readJson, sidecarError } from "../../_lib";
import { addListmonkSubscriber, listmonkSubscribers } from "@/lib/integrations/listmonk";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CreateSchema = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().max(128).optional(),
  listIds: z.array(z.number().int().positive()).min(1).max(50),
});

async function handleGET(req: Request) {
  try {
    await guardWorkspace();
    const sp = new URL(req.url).searchParams;
    const pageRaw = Number(sp.get("page"));
    return Response.json(
      await listmonkSubscribers({
        query: sp.get("query") ?? undefined,
        page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : undefined,
      }),
    );
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
      { subscriber: await addListmonkSubscriber(parsed.data) },
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
