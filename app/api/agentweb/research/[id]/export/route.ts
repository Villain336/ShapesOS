// ShapesOS — Phase 21A round 2 (WS=agentweb): export a research session.
//   GET /api/agentweb/research/:id/export?format=md|json&workspace=1
//   md   → the Markdown as a download (claims with citations, sources, notes, a receipts list)
//   json → { markdown, receipts[], exportedAt, exportedBy, seal }: the signed receipts behind every
//          source plus an HMAC seal over the Markdown and the receipt ids (null when the app has no
//          signing secret: it says so, it is never faked)
// The owner's private workspace records are left out unless the owner asks (workspace=1).

import { NextResponse } from "next/server";
import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { exportResearch } from "@/lib/agentweb/research/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await answerActor();
    const { id } = await ctx.params;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const url = new URL(req.url);
    const bundle = await exportResearch(workspace.id, user.id, id, { includeWorkspace: url.searchParams.get("workspace") === "1" });
    if (!bundle) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (url.searchParams.get("format") === "json") return NextResponse.json(bundle, { headers: { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="research-${id}.json"` } });
    return new Response(bundle.markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="research-${id}.md"` } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
