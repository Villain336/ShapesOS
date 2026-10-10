// ShapesOS — Phase 21A round 2 (WS=agentweb): GET /.well-known/http-message-signatures-directory
// — the public directory of this deployment's Web Bot Auth keys, so a site that receives a
// signed ShapesOS agent request can check the signature (Cloudflare Web Bot Auth; draft-
// meunier-webbotauth-*).
//
// PUBLIC BY DESIGN, READ-ONLY, UNAUTHENTICATED: verifiers are other people's servers. It
// lists PUBLIC keys only (no private material exists in its inputs), is the same for every
// caller apart from the signature over the request authority, writes nothing except the
// one-time creation of the deployment's first signing key, and is cached for 5 minutes.

import { buildDirectoryResponse } from "@/lib/agentweb/identity/directory";
import { directoryKeys, ensureActiveKey } from "@/lib/agentweb/identity/keys-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const now = new Date();
  const signingKey = await ensureActiveKey(now);
  const out = buildDirectoryResponse({ keys: await directoryKeys(now), signingKey, authority: new URL(req.url).host, nowSec: Math.floor(now.getTime() / 1000) });
  return new Response(out.body, { headers: out.headers });
}
