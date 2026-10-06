// ShapesOS — Phase 18.2 (WS=content): a preview of an Office file, server-side.
// GET /api/files/[fileId]/preview?workspaceId=[&version=N]
//   → { kind: "table", sheets: [{ name, rows }] }   (.xlsx — the existing exceljs reader)
//   → { kind: "text", text }                          (.docx — the existing text extractor)
//   → { kind: "none" }                                 (anything else: download to view)
// Images, video, audio, text and PDFs preview in the browser from the bytes
// (GET /api/files/[fileId]/versions/[n]); this route is only for the formats a
// browser can't show. Heavy readers load lazily (bundle-size rule).
// Access: requireWorkspaceAccess (viewer+) + the file's "view" right.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess } from "@/lib/route-utils";
import { readFileVersion } from "@/lib/filesystem/versions";
import { requireFileAction } from "@/lib/files/access";
import { fileActor, filesErrorResponse } from "@/lib/files/http";

export const dynamic = "force-dynamic";

const MAX_ROWS = 200;
const MAX_COLS = 30;
const MAX_TEXT = 60_000;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function GET(req: NextRequest, ctx: { params: Promise<{ fileId: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { fileId } = await ctx.params;
  const qs = req.nextUrl.searchParams;
  const access = await requireWorkspaceAccess(user.id, qs.get("workspaceId"), "viewer");
  if ("error" in access) return access.error;
  try {
    const { file } = await requireFileAction(fileActor(user.id, access.workspaceId, access.membership.role), fileId, "view");
    const version = qs.get("version") ? Number(qs.get("version")) : file.version;
    const v = await readFileVersion(access.workspaceId, fileId, version);
    if (!v) return Response.json({ error: "Version not found." }, { status: 404 });
    const lower = v.filename.toLowerCase();
    if (v.mimeType === XLSX || lower.endsWith(".xlsx")) {
      const { readXlsx } = await import("@/lib/documents/xlsx");
      const sheets = (await readXlsx(v.bytes, MAX_ROWS)).slice(0, 10).map((s) => ({
        name: s.name,
        rows: s.rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map((c) => (c === null || c === undefined ? "" : c instanceof Date ? c.toISOString().slice(0, 10) : String(c)))),
      }));
      return Response.json({ kind: "table", sheets }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (v.mimeType === DOCX || lower.endsWith(".docx")) {
      const { extractFileText } = await import("@/lib/search/text-index");
      const out = await extractFileText(v.filename, v.mimeType, v.bytes);
      return Response.json({ kind: "text", text: out.text.slice(0, MAX_TEXT), truncated: out.text.length > MAX_TEXT }, { headers: { "Cache-Control": "private, no-store" } });
    }
    return Response.json({ kind: "none" });
  } catch (err) {
    return filesErrorResponse(err, "GET /api/files/[fileId]/preview");
  }
}
