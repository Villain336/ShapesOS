// Marketr — upload a .zip (or single .html) into a site (milestone 7).
// POST /api/websites/[id]/upload  (multipart form: file, projectId)
//   → { ok, files: ["/…"], mock: false }
//
// File-source sites only. The archive is extracted into the site's working
// copy with zip-slip protection (see lib/connectors/zip.ts); binaries are
// skipped. A single .html file becomes /index.html.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { extractZipToProvider } from "@/lib/connectors/zip";
import { getSiteIdeProvider, ownedSite } from "@/lib/connectors/source";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Invalid form data" }, { status: 400 });
  }

  const projectId = form.get("projectId");
  const site = await ownedSite(user.id, typeof projectId === "string" ? projectId : null, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (site.sourceType !== "file") {
    return Response.json({ error: "Upload is only supported for file-source sites" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No file uploaded" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) return Response.json({ error: "Empty file" }, { status: 400 });
  if (buf.length > 50 * 1024 * 1024) {
    return Response.json({ error: "File too large (max 50 MB)" }, { status: 400 });
  }

  const working = await getSiteIdeProvider(site);
  const lower = file.name.toLowerCase();

  try {
    if (lower.endsWith(".zip")) {
      const files = await extractZipToProvider(buf, working);
      return Response.json({ ok: true, files, mock: false });
    }
    if (lower.endsWith(".html") || lower.endsWith(".htm")) {
      await working.writeFile("/index.html", buf.toString("utf8"));
      return Response.json({ ok: true, files: ["/index.html"], mock: false });
    }
    return Response.json({ error: "Upload a .zip archive or a single .html file" }, { status: 400 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 400 },
    );
  }
}
