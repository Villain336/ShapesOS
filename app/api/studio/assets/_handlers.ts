// Marketr — studio API: project asset library (milestone 22).
// GET    /api/studio/assets?projectId=&source=
// POST   /api/studio/assets { projectId, name, source, url, mimeType?, metadata? } (editor+)
// DELETE /api/studio/assets/[id] { projectId } (editor+)
// POST   /api/studio/assets/[id]/use-in-social { projectId, text, services } (editor+)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import {
  createAsset,
  deleteAsset,
  listAssets,
  useAssetInSocialPost,
  type AssetSource,
} from "@/lib/studio/service";
import { ownedProject, readJson, requireEditor } from "../_lib";

const SOURCES: AssetSource[] = ["upload", "generated"];

function serialize(r: Awaited<ReturnType<typeof listAssets>>[number]) {
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    url: r.url,
    mimeType: r.mimeType,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const project = await ownedProject(user.id, params.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const source = params.get("source");
  const rows = await listAssets(
    prisma,
    project.id,
    source && (SOURCES as string[]).includes(source) ? (source as AssetSource) : undefined,
  );
  return Response.json({ assets: rows.map(serialize) });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  const source = String(body.source ?? "upload");
  if (!(SOURCES as string[]).includes(source)) {
    return Response.json({ error: "Invalid asset source." }, { status: 400 });
  }
  try {
    const row = await createAsset(prisma, project.workspaceId, project.id, {
      name: String(body.name ?? ""),
      source: source as AssetSource,
      url: String(body.url ?? ""),
      mimeType: body.mimeType != null ? String(body.mimeType) : undefined,
      metadata: (body.metadata ?? undefined) as Record<string, unknown> | undefined,
    });
    return Response.json({ asset: serialize(row) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to add asset." },
      { status: 400 },
    );
  }
}

export async function deleteAssetHandler(req: Request, assetId: string) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  try {
    await deleteAsset(prisma, project.workspaceId, project.id, assetId);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to delete asset." },
      { status: 400 },
    );
  }
}

export async function useInSocialHandler(req: Request, assetId: string) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  try {
    const post = await useAssetInSocialPost(prisma, project.workspaceId, project.id, assetId, {
      text: String(body.text ?? ""),
      services: Array.isArray(body.services) ? body.services.map(String) : [],
    });
    return Response.json({ postId: post.id });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to create social post." },
      { status: 400 },
    );
  }
}
