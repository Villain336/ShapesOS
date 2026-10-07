// ShapesOS — Phase 19B (WS=engine): Dress Rehearsal towns.
// GET  /api/rehearsal/town/worlds → { worlds: WorldView[] }
// POST /api/rehearsal/town/worlds { kind: "generate", size: "small"|"medium", seed?, name? }
//                               | { kind: "figma", url, name?, metresPerPixel? } → 201 { world }
// Access: viewer reads, editor creates; entitlement dress_rehearsal (lib/sim/service.server.ts).

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { defaultSimDeps } from "@/lib/sim/deps.server";
import { townActor } from "@/lib/sim/http.server";
import { createGeneratedWorld, importFigmaWorld, listWorlds } from "@/lib/sim/service.server";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generate"), size: z.enum(["small", "medium"]), seed: z.number().int().min(0).max(2_147_483_647).optional(), name: z.string().max(120).optional() }),
  z.object({ kind: z.literal("figma"), url: z.string().url().max(2_000), name: z.string().max(120).optional(), metresPerPixel: z.number().min(0.05).max(20).optional() }),
]);

export async function GET() {
  try {
    const { user, workspace } = await guardWorkspace();
    const worlds = await listWorlds(await townActor(user.id, workspace.id));
    return Response.json({ worlds }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await townActor(user.id, workspace.id);
    const body = Body.parse(await readJson(req));
    const world = body.kind === "generate" ? await createGeneratedWorld(actor, body) : await importFigmaWorld(actor, body, defaultSimDeps);
    return Response.json({ world }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
