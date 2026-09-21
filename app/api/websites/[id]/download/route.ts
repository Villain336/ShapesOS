// Marketr — download a site as a .zip (milestone 7).
// GET /api/websites/[id]/download?projectId=… → application/zip

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { zipProviderFiles } from "@/lib/connectors/zip";
import { getSiteIdeProvider, ownedSite } from "@/lib/connectors/source";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const site = await ownedSite(
    user.id,
    req.nextUrl.searchParams.get("projectId"),
    id,
  );
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  try {
    const zip = await zipProviderFiles(await getSiteIdeProvider(site));
    const filename = `${site.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site"}.zip`;
    return new Response(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(zip.length),
      },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Download failed" },
      { status: 500 },
    );
  }
}
