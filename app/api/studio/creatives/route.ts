// Marketr — studio creatives API (Phase 4, T2).
// GET  /api/studio/creatives?channelTemplate=&formatTrack=&status=&q=
// POST /api/studio/creatives { name, channelTemplate?, formatTrack, size, source? } (editor)

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createCreative, listCreatives } from "@/lib/studio/creatives";
import {
  creativeErrorResponse,
  guardWorkspace,
  readJson,
} from "./_lib";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  channelTemplate: z.enum(["print", "email", "social"]).default("print"),
  formatTrack: z.string().trim().min(1).max(40),
  size: z.string().trim().min(1).max(40),
  source: z.enum(["upload"]).default("upload"),
});

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const qs = new URL(req.url).searchParams;
    const creatives = await listCreatives(prisma, workspace.id, {
      channelTemplate: qs.get("channelTemplate") ?? undefined,
      formatTrack: qs.get("formatTrack") ?? undefined,
      status: qs.get("status") ?? undefined,
      q: qs.get("q") ?? undefined,
    });
    return Response.json({ creatives });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const parsed = CreateSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const creative = await createCreative(prisma, workspace.id, {
      name: parsed.data.name,
      channelTemplate: parsed.data.channelTemplate,
      formatTrack: parsed.data.formatTrack,
      size: parsed.data.size,
      source: parsed.data.source,
      createdBy: user.id,
    });
    return Response.json({ creative }, { status: 201 });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}
