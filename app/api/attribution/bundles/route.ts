// Marketr — Physical attribution kit API: measurement bundles.
// GET  /api/attribution/bundles       → list (workspace-scoped, with stats)
// POST /api/attribution/bundles (editor+) → one-click bundle creation:
//        provisions a tracking number (R5 provider layer), reserves the
//        vanity slug, mints the promo code.

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import {
  createBundle,
  listBundles,
  bundleStats,
  publicOrigin,
} from "@/lib/physical/bundles";
import { qrPngDataUrl } from "@/lib/physical/qr";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  campaignName: z.string().trim().min(1).max(160),
  destinationUrl: z.string().trim().min(1).max(2048),
  vanitySlug: z.string().trim().min(1).max(80).optional(),
  areaCode: z.string().trim().max(10).optional(),
  utmSource: z.string().trim().max(64).optional(),
  utmMedium: z.string().trim().max(64).optional(),
  utmCampaign: z.string().trim().max(160).optional(),
});

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const origin = publicOrigin(req);
  const bundles = await listBundles(workspace.id);
  const withStats = await Promise.all(
    bundles.map(async (b) => ({
      ...b,
      vanityUrl: `${origin}/r/${b.vanitySlug}`,
      qrPreview: await qrPngDataUrl(`${origin}/r/${b.vanitySlug}`, b.qrStyle),
      stats: await bundleStats(b),
    })),
  );
  return Response.json({ bundles: withStats, workspaceId: workspace.id });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;

  try {
    const bundle = await createBundle({ workspaceId: workspace.id, ...d });
    const origin = publicOrigin(req);
    return Response.json(
      {
        bundle: {
          ...bundle,
          vanityUrl: `${origin}/r/${bundle.vanitySlug}`,
          qrPreview: await qrPngDataUrl(`${origin}/r/${bundle.vanitySlug}`, bundle.qrStyle),
        },
      },
      { status: 201 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Bundle creation failed";
    const status = msg.startsWith("Number provisioning failed") ? 502 : 400;
    return Response.json({ error: msg }, { status });
  }
}
