// Marketr — Physical attribution kit API: QR download.
// GET /api/attribution/bundles/[id]/qr?format=png|svg → the bundle's QR code
// as a downloadable file. Content is the vanity URL.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getBundle, vanityUrlFor } from "@/lib/physical/bundles";
import { qrPngDataUrl, qrSvgString } from "@/lib/physical/qr";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const { id } = await ctx.params;
  const bundle = await getBundle(workspace.id, id);
  if (!bundle) return Response.json({ error: "Not found" }, { status: 404 });

  const origin = new URL(req.url).origin;
  const vanityUrl = vanityUrlFor(bundle, origin);
  const format = new URL(req.url).searchParams.get("format") ?? "png";
  const filename = `${bundle.vanitySlug}-qr`;

  if (format === "svg") {
    const svg = await qrSvgString(vanityUrl, bundle.qrStyle);
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Content-Disposition": `attachment; filename="${filename}.svg"`,
      },
    });
  }
  const dataUrl = await qrPngDataUrl(vanityUrl, bundle.qrStyle);
  const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="${filename}.png"`,
    },
  });
}
