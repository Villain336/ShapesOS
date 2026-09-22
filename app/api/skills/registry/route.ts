// Marketr — skill registry + URL preview + re-pin + uninstall (milestone 21).
// GET    /api/skills/registry                    → { packs: metadata } (viewer+)
// POST   /api/skills/preview-url {workspaceId, url} → { name, description, version, sha, warnings[] } (admin+ or skills.install)
// POST   /api/skills/[id]/repin {workspaceId}   → { skill } re-resolves SHA (admin+ or skills.install; audited)
// DELETE /api/skills/[id]?workspaceId=           → { ok } (admin+ or skills.install; audited)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import {
  workspaceIdFrom,
  badRequest,
  notFound,
  requireWorkspaceAccess,
  publicSkill,
} from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { listRegistryPacks } from "@/lib/skills/registry";
import { previewFromUrl, SkillImportError } from "@/lib/skills/importer";
import { getSkill, uninstallSkill, SkillServiceError } from "@/lib/skills/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;
  return Response.json({ packs: listRegistryPacks() });
}
