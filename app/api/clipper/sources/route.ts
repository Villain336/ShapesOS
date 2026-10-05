// Marketr — Phase 13C: clip sources.
// POST /api/clipper/sources — create from a file upload (multipart) or a URL (JSON).
//   Upload → bytes go to the storage adapter (UUID key, no filenames in keys);
//   creates ClipSource(origin "upload") + ClipJob{kind:"transcribe"}.
//   JSON {url, title} → ClipSource(origin "url"); the file is NOT downloaded
//   yet — durationSec stays null, transcript pending. The transcribe job
//   downloads it when it runs.
// GET  /api/clipper/sources — dense list with clip counts.

import { assertSafeUrl, UnsafeUrlError } from "@/lib/safe-url";
import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "../../integrations/_lib";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  CLIPPER_MAX_UPLOAD_BYTES,
  createClipJob,
  storeUpload,
} from "../_pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UrlSourceSchema = z.object({
  url: z.string().trim().url().max(2048),
  title: z.string().trim().min(1).max(200),
});

const sourceSelect = {
  id: true, title: true, origin: true, durationSec: true,
  transcriptStatus: true, createdAt: true,
  _count: { select: { clips: true } },
} as const;

interface SourceRow {
  id: string; title: string; origin: string;
  durationSec: number | null; transcriptStatus: string;
  createdAt: Date; _count: { clips: number };
}

function shapeSource(s: SourceRow) {
  return {
    id: s.id, title: s.title, origin: s.origin,
    durationSec: s.durationSec, transcriptStatus: s.transcriptStatus,
    clipCount: s._count.clips, createdAt: s.createdAt,
  };
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const sources = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clipSource.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: sourceSelect,
      }),
    );
    return Response.json({ sources: sources.map(shapeSource) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const ct = req.headers.get("content-type") ?? "";

    let created: { source: Record<string, unknown>; job: Record<string, unknown> };

    if (ct.includes("multipart/form-data")) {
      const fd = await req.formData();
      const file = fd.get("file");
      const title = String(fd.get("title") ?? "").trim();
      if (!(file instanceof File)) {
        return Response.json({ error: "multipart field 'file' is required." }, { status: 400 });
      }
      if (file.size > CLIPPER_MAX_UPLOAD_BYTES) {
        return Response.json({ error: "File too large (500 MB cap)." }, { status: 413 });
      }
      if (file.size === 0) {
        return Response.json({ error: "Empty file." }, { status: 400 });
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const fileRef = await storeUpload(bytes, file.type);
      const name = (file.name || "untitled").slice(0, 200);
      const source = await withWorkspaceScope(workspace.id, (tx) =>
        tx.clipSource.create({
          data: {
            workspaceId: workspace.id,
            origin: "upload",
            title: title || name,
            fileRef,
          },
          select: sourceSelect,
        }),
      );
      const job = await createClipJob(workspace.id, { kind: "transcribe", sourceId: source.id });
      created = { source: shapeSource(source), job };
    } else {
      const parsed = UrlSourceSchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        return Response.json(
          { error: "Provide either multipart 'file' or JSON {url, title}.", issues: parsed.error.issues },
          { status: 400 },
        );
      }
      // SSRF guard: refuse internal targets at creation (the pipeline's
      // safeFetch re-validates at download time and on every redirect hop).
      try {
        await assertSafeUrl(parsed.data.url);
      } catch (err) {
        return Response.json(
          { error: `URL refused: ${err instanceof UnsafeUrlError ? err.message : "not allowed"}` },
          { status: 400 },
        );
      }
      const source = await withWorkspaceScope(workspace.id, (tx) =>
        tx.clipSource.create({
          data: {
            workspaceId: workspace.id,
            origin: "url",
            title: parsed.data.title,
            sourceUrl: parsed.data.url,
            durationSec: null,
            transcriptStatus: "pending",
          },
          select: sourceSelect,
        }),
      );
      const job = await createClipJob(workspace.id, { kind: "transcribe", sourceId: source.id });
      created = { source: shapeSource(source), job };
    }
    return Response.json(created, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
