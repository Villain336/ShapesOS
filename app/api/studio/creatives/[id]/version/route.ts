// Marketr — studio creative versioning (Phase 4, T2).
// POST /api/studio/creatives/[id]/version { name? } (editor)
// New row v+1 (draft); prior row archived. Approvals bind a specific row's
// creativeHash, so versioning can never silently change approved content.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { versionCreative } from "@/lib/studio/creatives";
import {
  creativeErrorResponse,
  guardWorkspace,
  readJson,
} from "../../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const VersionSchema = z.object({ name: z.string().trim().min(1).max(120).optional() });

export async function POST(req: Request, { params }: Params) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const parsed = VersionSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const { previous, next } = await versionCreative(prisma, workspace.id, id, {
      name: parsed.data.name,
      createdBy: user.id,
    });
    return Response.json({ previous, next }, { status: 201 });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}
