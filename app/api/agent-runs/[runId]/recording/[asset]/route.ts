// Marketr — Phase 16 slice 6: workspace-scoped recording artifact serving.
//
// GET /api/agent-runs/[runId]/recording/video → the run's WebM (inline,
// Range-enabled so the <video> player can seek).
// GET /api/agent-runs/[runId]/recording/trace → trace.zip (attachment).
//
// Workspace ownership is re-checked on every request through
// resolveRecordingAsset() (slice-5 service, RLS fail-closed): a foreign
// runId yields 404, never bytes. No raw filesystem paths ever reach the
// client.

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { isRecordingAsset, resolveRecordingAsset } from "@/lib/agents/runs/artifacts";

export const dynamic = "force-dynamic";

function streamFile(absPath: string, start: number, end: number): ReadableStream {
  return Readable.toWeb(createReadStream(absPath, { start, end })) as ReadableStream;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string; asset: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { runId, asset } = await params;
  if (!isRecordingAsset(asset)) {
    return Response.json({ error: "Unknown asset" }, { status: 404 });
  }

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const resolved = await resolveRecordingAsset(workspace.id, runId, asset);
  if (!resolved) return Response.json({ error: "Not found" }, { status: 404 });

  const headers = new Headers({
    "Content-Type": resolved.contentType,
    "Accept-Ranges": "bytes",
  });

  // Range support for the video player (seeking); traces always download whole.
  const range = asset === "video" ? req.headers.get("range") : null;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match) {
    const size = resolved.sizeBytes;
    const start = match[1] ? parseInt(match[1], 10) : Math.max(0, size - (match[2] ? parseInt(match[2], 10) : 0));
    const end = match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start >= size || end < start) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(streamFile(resolved.absPath, start, end), { status: 206, headers });
  }

  headers.set("Content-Length", String(resolved.sizeBytes));
  if (asset === "trace") {
    headers.set("Content-Disposition", `attachment; filename="${resolved.filename}"`);
  }
  return new Response(streamFile(resolved.absPath, 0, resolved.sizeBytes - 1), { headers });
}
