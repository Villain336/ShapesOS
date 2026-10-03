// ShapesOS — Studio design → social post draft (Phase 4b).
//
// Renders a saved Studio design page to PNG with the same server renderer
// as /api/studio/designs/render (validate → SVG → sharp), stores the image
// in the workspace filesystem (/files/social/studio/…) and creates a social
// post DRAFT with it attached. Nothing is published here: the draft opens in
// the composer and goes through submit → approval like any other post.

import { prisma } from "@/lib/prisma";
import { NotFoundError, BadRequestError } from "@/lib/api/errors";
import { renderDocumentToPng, type RenderOptions, type RenderResult } from "@/lib/design/render-server";
import { createPost, storeSocialMedia, type SerializedPost } from "./publications";

export interface StudioExportDeps {
  render?: (doc: unknown, opts: RenderOptions) => Promise<RenderResult>;
  /** Social posts read best at 2× the design's pixel size (capped by the renderer). */
  defaultScale?: number;
}

export async function sendDesignToSocial(
  workspaceId: string,
  userId: string,
  designId: string,
  opts: { pageId?: string; scale?: number; content?: string } = {},
  deps: StudioExportDeps = {},
): Promise<{ post: SerializedPost; warnings: number }> {
  const design = await prisma.design.findFirst({
    where: { id: designId, workspaceId },
    select: { id: true, name: true, document: true },
  });
  if (!design) throw new NotFoundError("Design not found.");
  const render = deps.render ?? renderDocumentToPng;
  const result = await render(design.document, { pageId: opts.pageId, scale: opts.scale ?? deps.defaultScale ?? 2 });
  if (!result.ok) throw new BadRequestError(`This design couldn't be exported: ${result.error}.`);
  const media = await storeSocialMedia({
    workspaceId,
    userId,
    bytes: result.png,
    filename: `${design.name || "design"}.png`,
    folder: "studio",
  });
  const post = await createPost(workspaceId, userId, {
    content: opts.content ?? "",
    media: [{ ...media, width: result.width, height: result.height }],
    utmCampaign: design.name?.trim() ? design.name.trim().slice(0, 120) : null,
    source: "studio",
    sourceRef: design.id,
  });
  return { post, warnings: result.warnings.length };
}
