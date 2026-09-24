// Marketr — Calls API: the embeddable DNI snippet.
// GET /api/calls/dni/snippet?workspace=<id> — PUBLIC BY DESIGN, serves
// application/javascript. Embed: <script src="…/api/calls/dni/snippet?workspace=WS"></script>

import { dniSnippetJs } from "@/lib/calls/dni";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const workspaceId = (sp.get("workspace") ?? "").trim().slice(0, 64);
  if (!workspaceId) {
    return new Response("/* workspace is required */", {
      status: 400,
      headers: { "content-type": "application/javascript" },
    });
  }
  const origin = new URL(req.url).origin;
  return new Response(dniSnippetJs(workspaceId, origin), {
    status: 200,
    headers: {
      "content-type": "application/javascript",
      "cache-control": "public, max-age=300",
    },
  });
}
