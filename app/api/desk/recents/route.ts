// ShapesOS — Phase 18.1 (WS=desk): the caller's recent apps and records.
//   GET  /api/desk/recents?limit=8           → { recents }
//   POST /api/desk/recents { href, title }   → { recent | null }  (the browser reports a visit)
// viewer+ (the caller's own list; owner-only RLS). Only same-app /dashboard
// paths are kept (lib/desktop/recents.ts normalizeRecentHref).

import { errorResponse } from "@/lib/api/errors";
import { intQuery, parseQuery, validateBody, z } from "@/lib/api/validate";
import { listRecents, recordRecent } from "@/lib/desktop/store.server";
import { RECENTS_KEEP, RECENTS_SHOWN } from "@/lib/desktop/recents";
import { deskGuard, NO_STORE } from "../_lib";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({ limit: intQuery(RECENTS_SHOWN, 1, RECENTS_KEEP) });

export async function GET(req: Request) {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  const q = parseQuery(QuerySchema, new URL(req.url).searchParams);
  if (!q.ok) return q.error;
  try {
    return Response.json({ recents: await listRecents(ctx.workspaceId, ctx.userId, q.data.limit) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/desk/recents");
  }
}

const PostSchema = z.object({ href: z.string().max(400), title: z.string().max(300).optional() });

export async function POST(req: Request) {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const body = validateBody(PostSchema, await req.json());
    if (!body.ok) return body.error;
    const recent = await recordRecent(ctx.workspaceId, ctx.userId, body.data);
    return Response.json({ recent }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "POST /api/desk/recents");
  }
}
