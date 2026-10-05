// ShapesOS — Phase 9 (apps): publish / unpublish.
//   POST   /api/apps/[slug]/publish — the draft goes live as version+1 (admin+).
//          This is the approval step for an agent-drafted app.
//   DELETE /api/apps/[slug]/publish — take the app off the runtime (admin+).

import { appsError, appsGuard } from "../../_lib";
import { publishApp, unpublishApp } from "@/lib/apps/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function POST(_req: Request, { params }: Params) {
  const actor = await appsGuard("admin");
  if (actor instanceof Response) return actor;
  try {
    const { slug } = await params;
    return Response.json(await publishApp(actor, slug));
  } catch (err) {
    return appsError(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const actor = await appsGuard("admin");
  if (actor instanceof Response) return actor;
  try {
    const { slug } = await params;
    await unpublishApp(actor, slug);
    return Response.json({ published: false });
  } catch (err) {
    return appsError(err);
  }
}
