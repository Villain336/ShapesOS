// Marketr — Listmonk sidecar: mailing lists (Phase 12).
// GET  /api/integrations/listmonk/lists → { lists }
// POST /api/integrations/listmonk/lists { name, type?, optin?, description? } → { list }

import { z } from "zod";
import { guardWorkspace, readJson, sidecarError } from "../../_lib";
import { createListmonkList, listmonkLists } from "@/lib/integrations/listmonk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(128),
  type: z.enum(["public", "private"]).optional(),
  optin: z.enum(["single", "double"]).optional(),
  description: z.string().trim().max(500).optional(),
});

export async function GET() {
  try {
    await guardWorkspace();
    return Response.json({ lists: await listmonkLists() });
  } catch (e) {
    return sidecarError(e);
  }
}

export async function POST(req: Request) {
  try {
    await guardWorkspace({ editor: true });
    const parsed = CreateSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    return Response.json({ list: await createListmonkList(parsed.data) }, { status: 201 });
  } catch (e) {
    return sidecarError(e);
  }
}
