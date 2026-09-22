// Marketr — studio API: Canva folders (milestone 22).
// GET /api/studio/canva/folders?projectId= → { folders } (viewer OK).

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { createCanvaPort } from "@/lib/studio/canva";
import { listStudioFolders } from "@/lib/studio/service";
import { canvaClientConfig, ownedProject } from "../../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  const folders = await listStudioFolders(prisma, project.workspaceId, createCanvaPort(), canvaClientConfig());
  return NextResponse.json({ folders });
}
