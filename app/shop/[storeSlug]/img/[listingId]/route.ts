// ShapesOS — Phase 10 (store): GET /shop/[storeSlug]/img/[listingId] — a
// listed product's image for the public storefront.
//
// PUBLIC BY DESIGN, READ-ONLY: only a PUBLISHED store resolves, and only the
// image of one of its LISTED listings of an ACTIVE product is served (the
// listing → WorkspaceFile link, validated on save to be an inline-safe image
// of the same workspace). The bytes go out with the sniffed MIME recorded at
// upload, nosniff and a sandbox CSP (lib/filesystem/download.ts), and only
// for the inline-safe image types — anything else 404s.

import { readFile } from "@/lib/filesystem/service";
import { buildDownloadHeaders, isInlineSafeMime } from "@/lib/filesystem/download";
import { listingImage, resolvePublishedStore } from "@/lib/ops/store/catalog";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function GET(_req: Request, { params }: { params: Promise<{ storeSlug: string; listingId: string }> }) {
  const { storeSlug, listingId } = await params;
  const store = await resolvePublishedStore(storeSlug);
  if (!store) return notFound();
  const fileId = await listingImage(store, listingId);
  if (!fileId) return notFound();
  const file = await readFile({ workspaceId: store.workspaceId, fileId });
  if (!file || !isInlineSafeMime(file.meta.mimeType) || !file.meta.mimeType.startsWith("image/")) return notFound();
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      ...buildDownloadHeaders(file.meta.mimeType, file.meta.filename),
      "cache-control": "public, max-age=300",
    },
  });
}
