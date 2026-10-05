// ShapesOS — Phase 9 (apps): GET /api/apps (list) · POST /api/apps (new draft app).
// Reads: viewer+ (viewers see published apps only). Create: editor+; the
// app starts as a draft (the starter spec, or the spec given) — an admin
// publishes it.

import { appsError, appsGuard, readJsonBody } from "./_lib";
import { createApp, listApps } from "@/lib/apps/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await appsGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    return Response.json({ apps: await listApps(actor) });
  } catch (err) {
    return appsError(err);
  }
}

export async function POST(req: Request) {
  const actor = await appsGuard("editor");
  if (actor instanceof Response) return actor;
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  try {
    const app = await createApp(actor, {
      name: typeof body.name === "string" ? body.name : undefined,
      slug: typeof body.slug === "string" ? body.slug : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      spec: body.spec,
    });
    return Response.json({ app }, { status: 201 });
  } catch (err) {
    return appsError(err);
  }
}
