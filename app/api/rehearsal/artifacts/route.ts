// ShapesOS — Phase 19B (WS=panel): a walk screenshot from blob storage.
//   GET ?ref=blob:rehearsal/<workspaceId>/… → the image   (viewer+, dress_rehearsal)
// Only refs in the "rehearsal" namespace under THIS workspace's prefix are
// served; anything else is a plain 404 (no oracle).

import { errorResponse } from "@/lib/api/errors";
import { blobGet, parseBlobRef } from "@/lib/filesystem/storage";
import { gate } from "@/lib/panel/service.server";
import { rehearsalGuard } from "../_lib";

export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "Not found." }, { status: 404 });

export async function GET(req: Request) {
  try {
    const actor = await rehearsalGuard("viewer");
    if (actor instanceof Response) return actor;
    await gate(actor, "viewer");
    const ref = new URL(req.url).searchParams.get("ref") ?? "";
    const loc = parseBlobRef(ref);
    if (!loc || loc.namespace !== "rehearsal" || !loc.path.startsWith(`${actor.workspaceId}/`) || !/\.png$/.test(loc.path)) return notFound();
    const bytes = await blobGet("rehearsal", loc.path);
    if (!bytes) return notFound();
    return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
  } catch (err) {
    return errorResponse(err, "GET /api/rehearsal/artifacts", req);
  }
}
