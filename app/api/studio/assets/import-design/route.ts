// Marketr — studio API: import a Canva design's thumbnail + metadata into the asset library (milestone 22).
// POST /api/studio/assets/import-design { projectId, designId } (editor+)

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { createCanvaPort } from "@/lib/studio/canva";
import { importCanvaDesignAsAsset } from "@/lib/studio/service";
import { canvaClientConfig, ownedProject, readJson, requireEditor } from "../../_lib";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;

  const designId = String(body.designId ?? "").trim();
  if (!designId) return NextResponse.json({ error: "designId is required." }, { status: 400 });
  try {
    const asset = await importCanvaDesignAsAsset(
      prisma,
      project.workspaceId,
      project.id,
      createCanvaPort(),
      canvaClientConfig(),
      designId,
    );
    return NextResponse.json({ asset });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Import failed." },
      { status: 502 },
    );
  }
}
