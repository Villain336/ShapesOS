// ShapesOS — serve a social media file for previews (Phase 4b).
// GET /api/social/media/[fileId] → bytes (viewer+)
// Only files under /files/social/ of the caller's workspace. Images and
// video are served inline (so <img>/<video> previews work) from the sniffed
// MIME stored at upload, with nosniff + a sandbox CSP.

import { readFile } from "@/lib/filesystem/service";
import { SOCIAL_MEDIA_ROOT } from "@/lib/social/publications";
import { NotFoundError } from "@/lib/api/errors";
import { guardWorkspace, socialError } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/quicktime", "video/webm"]);

export async function GET(_req: Request, ctx: { params: Promise<{ fileId: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { fileId } = await ctx.params;
    const file = await readFile({ workspaceId: workspace.id, fileId });
    if (!file || !file.meta.logicalPath.startsWith(`${SOCIAL_MEDIA_ROOT}/`) || !INLINE.has(file.meta.mimeType)) {
      throw new NotFoundError("Media not found.");
    }
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "content-type": file.meta.mimeType,
        "content-length": String(file.bytes.length),
        "content-disposition": `inline; filename="${file.meta.filename.replace(/["\\\r\n]/g, "_")}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "private, max-age=300",
      },
    });
  } catch (e) {
    return socialError(e);
  }
}
