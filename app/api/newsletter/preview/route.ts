// Marketr — newsletter API: server-side HTML preview (milestone 19).
// POST /api/newsletter/preview { projectId, tiptap, brandKitId? }
// Renders the current editor doc through react-email → HTML. Used by the
// composer's live preview pane.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { brandFromKit, normalizeDoc } from "@/lib/newsletter/blocks";
import { renderNewsletter } from "@/lib/newsletter/render";
import { appBaseUrl } from "@/lib/newsletter/service";
import { ownedProject, readJson } from "../_lib";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const doc = normalizeDoc(body.tiptap);
  let brand = brandFromKit({});
  if (typeof body.brandKitId === "string" && body.brandKitId) {
    const kit = await prisma.brandKit.findFirst({ where: { id: body.brandKitId, workspaceId: project.workspaceId } });
    if (kit) brand = brandFromKit({ colors: kit.colors, fonts: kit.fonts, logoPath: kit.logoPath, name: kit.name });
  }
  const html = await renderNewsletter(doc, { brand, baseUrl: appBaseUrl(), unsubscribeToken: "preview" });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
