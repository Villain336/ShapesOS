// Marketr — remote file read/write API (milestone 6).
// GET  /api/sites/[id]/file?projectId=…&path=…        → { content, truncated, path }
// POST /api/sites/[id]/file { projectId, path, content, source, summary }
//      source: "manual" | "ai". Every write is appended to the audit log
//      (FileChangeLog); AI-applied writes record approvedBy = the user.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getSiteFileProvider } from "@/lib/sitefiles";
import { sanitizePath } from "@/lib/sitefiles/paths";
import { ownedConnection, readJsonBody } from "@/lib/sitefiles/api";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const connection = await ownedConnection(user.id, sp.get("projectId"), id);
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }

  let path: string;
  try {
    path = sanitizePath(sp.get("path"));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid path" },
      { status: 400 },
    );
  }

  try {
    const result = await getSiteFileProvider(connection).readFile(path);
    return Response.json({ ...result, path });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Cannot read file" },
      { status: 500 },
    );
  }
}

interface WriteBody {
  projectId?: string;
  path?: string;
  content?: string;
  /** "manual" = user edit; "ai" = user approved an AI proposal. */
  source?: "manual" | "ai";
  summary?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await readJsonBody<WriteBody>(req);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const connection = await ownedConnection(user.id, body.projectId, id);
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }

  let path: string;
  try {
    path = sanitizePath(body.path);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid path" },
      { status: 400 },
    );
  }
  if (typeof body.content !== "string") {
    return Response.json({ error: "Content is required" }, { status: 400 });
  }

  const source = body.source === "ai" ? "ai" : "manual";
  const summary = (body.summary ?? "").trim().slice(0, 280) ||
    (source === "ai" ? "Applied AI proposal" : "Manual edit");

  try {
    await getSiteFileProvider(connection).writeFile(path, body.content);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Cannot write file" },
      { status: 500 },
    );
  }

  // Append-only audit log — the accountability backbone of the supervised rung.
  await prisma.fileChangeLog.create({
    data: {
      projectId: connection.projectId,
      connectionId: connection.id,
      filePath: path,
      actor: "user",
      action: source === "ai" ? "ai_applied" : "save",
      summary,
      approvedBy: source === "ai" ? user.id : null,
    },
  });

  return Response.json({ ok: true, path });
}
