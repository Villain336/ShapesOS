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
//
// Deploy PR: the bytes come from the shared blob store (any replica can
// serve a recording the worker made); rows from before it still resolve to
// their local file while it exists.

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { isRecordingAsset, readRecordingBytes, resolveRecordingAsset } from "@/lib/agents/runs/artifacts";

export const dynamic = "force-dynamic";

/** Largest slice served for an open-ended Range request. */
const RANGE_CHUNK_BYTES = 4 * 1024 * 1024;

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
    // "bytes=-N" is a suffix range (the last N bytes).
    const suffix = !match[1];
    const start = suffix ? Math.max(0, size - (match[2] ? parseInt(match[2], 10) : 0)) : parseInt(match[1]!, 10);
    // An open-ended range ("bytes=N-", what <video> sends) is answered in
    // bounded chunks so seeking never loads a whole recording into memory.
    const end = suffix
      ? size - 1
      : match[2]
        ? Math.min(parseInt(match[2], 10), size - 1)
        : Math.min(size - 1, start + RANGE_CHUNK_BYTES - 1);
    if (Number.isNaN(start) || Number.isNaN(end) || start >= size || end < start) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const part = await readRecordingBytes(resolved.location, { start, end });
    if (!part) return Response.json({ error: "Not found" }, { status: 404 });
    headers.set("Content-Range", `bytes ${start}-${start + part.length - 1}/${size}`);
    headers.set("Content-Length", String(part.length));
    return new Response(new Uint8Array(part), { status: 206, headers });
  }

  const bytes = await readRecordingBytes(resolved.location);
  if (!bytes) return Response.json({ error: "Not found" }, { status: 404 });
  headers.set("Content-Length", String(bytes.length));
  if (asset === "trace") {
    headers.set("Content-Disposition", `attachment; filename="${resolved.filename}"`);
  }
  return new Response(new Uint8Array(bytes), { headers });
}
