// Marketr — skill URL preview (milestone 21, spec §5 flow 2).
// POST /api/skills/preview-url { workspaceId, url } → { name, description, version, sha, warnings[] }
// Admin+ or skills.install grant. Never installs — install is a separate deliberate action.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest } from "@/lib/route-utils";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z, boundedString } from "@/lib/api/validate";
import { previewFromUrl, SkillImportError } from "@/lib/skills/importer";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  url: boundedString(2000, "url"),
});

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJsonBody(req);
  const v = validateBody(BodySchema, body);
  if (!v.ok) return v.error;
  const workspaceId = workspaceIdFrom(req, v.data);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "skills.install"))) {
    return forbidden("skills.install permission required.");
  }
  const url = v.data.url;
  try {
    const preview = await previewFromUrl(url);
    return Response.json({
      name: preview.name,
      description: preview.description,
      version: preview.version,
      sha: preview.sha,
      warnings: preview.warnings,
    });
  } catch (err) {
    if (err instanceof SkillImportError) return badRequest(err.message);
    throw err;
  }
}
