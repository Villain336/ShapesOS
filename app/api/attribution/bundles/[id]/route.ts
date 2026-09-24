// Marketr — Physical attribution kit API: one bundle.
// PATCH /api/attribution/bundles/[id] (editor+) → { status: active|disabled }
//        or { regenerateQr: true } (cycles the QR render preset; the vanity
//        URL never changes, so printed codes keep working).

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { setBundleStatus, regenerateQrStyle, vanityUrlFor, publicOrigin } from "@/lib/physical/bundles";
import { qrPngDataUrl } from "@/lib/physical/qr";

const PatchSchema = z.object({
  status: z.enum(["active", "disabled"]).optional(),
  regenerateQr: z.literal(true).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  const { id } = await ctx.params;
  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success || (!parsed.data.status && !parsed.data.regenerateQr)) {
    return Response.json({ error: "Invalid input", issues: parsed.error?.issues }, { status: 400 });
  }

  try {
    const bundle = parsed.data.regenerateQr
      ? await regenerateQrStyle(workspace.id, id)
      : await setBundleStatus(workspace.id, id, parsed.data.status!);
    const origin = publicOrigin(req);
    const vanityUrl = vanityUrlFor(bundle, origin);
    return Response.json({ bundle: { ...bundle, vanityUrl, qrPreview: await qrPngDataUrl(vanityUrl, bundle.qrStyle) } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Not found" }, { status: 404 });
  }
}
