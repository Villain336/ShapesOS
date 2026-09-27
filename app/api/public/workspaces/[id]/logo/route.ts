// Marketr — public white-label workspace logo (Phase 13 Wave A, worker 6).
// GET /api/public/workspaces/[id]/logo → the workspace's white-label logo image.
// Unauthenticated: this is a public brand asset, referenced by the public
// review landing page. No capability leak: it reveals only the logo the
// workspace owner chose to publish, keyed by workspace id.

import { loadWhiteLabelLogo } from "@/lib/brand-logo";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const file = await loadWhiteLabelLogo(id.trim().slice(0, 120));
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.mime,
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": `inline; filename="${file.filename}"`,
    },
  });
}
