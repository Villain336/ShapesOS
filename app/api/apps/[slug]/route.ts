// ShapesOS — Phase 9 (apps): one app.
//   GET    /api/apps/[slug]  — the app: live spec, and the draft for editors+
//   PUT    /api/apps/[slug]  — replace the draft spec (editor+; never publishes)
//   DELETE /api/apps/[slug]  — delete the app and its records (admin+)

import { appsError, appsGuard, readJsonBody } from "../_lib";
import { deleteApp, loadApp, saveDraft } from "@/lib/apps/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const actor = await appsGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const { slug } = await params;
    return Response.json({ app: await loadApp(actor, slug) });
  } catch (err) {
    return appsError(err);
  }
}

export async function PUT(req: Request, { params }: Params) {
  const actor = await appsGuard("editor");
  if (actor instanceof Response) return actor;
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  try {
    const { slug } = await params;
    const spec = await saveDraft(actor, slug, body.spec);
    return Response.json({ draftSpec: spec });
  } catch (err) {
    return appsError(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const actor = await appsGuard("admin");
  if (actor instanceof Response) return actor;
  try {
    const { slug } = await params;
    await deleteApp(actor, slug);
    return Response.json({ deleted: true });
  } catch (err) {
    return appsError(err);
  }
}
