// ShapesOS — global record search for ⌘K (Phase 4a).
// GET /api/search/records?q=<text>&kinds=lead,invoice&limit=5
//   → { query, results: [{ kind, id, title, subtitle, href }] }
// Any member (viewer+) of the current workspace; each record type is further
// gated by RECORD_MIN_ROLE. Workspace-scoped under RLS (lib/search/records).

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { parseQuery, z } from "@/lib/api/validate";
import { RECORD_KINDS, normalizeQuery, searchRecords, type RecordKind } from "@/lib/search/records";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  q: z.string().max(200).optional(),
  kinds: z
    .string()
    .max(200)
    .optional()
    .transform((s) => (s ? s.split(",").map((k) => k.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(RECORD_KINDS)).optional()),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
    if (!membership) return forbidden();
    const parsed = parseQuery(QuerySchema, req.nextUrl.searchParams);
    if (!parsed.ok) return parsed.error;
    const query = normalizeQuery(parsed.data.q ?? "");
    const results = query
      ? await searchRecords(workspace.id, membership.role, query, {
          perKind: parsed.data.limit ?? 5,
          kinds: parsed.data.kinds as RecordKind[] | undefined,
        })
      : [];
    return Response.json({ query, results }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/search/records");
  }
}
