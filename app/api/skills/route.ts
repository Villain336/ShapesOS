// Marketr — skills library API (milestone 21, spec §5 flows 1–2, §7).
// GET  /api/skills?workspaceId=          → { skills } (viewer+; no skillMd bodies)
// POST /api/skills { workspaceId, source: "registry"|"url"|"upload", ... }
//   → { skill } (admin+ or skills.install grant). Audited (skill_installed).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import {
  workspaceIdFrom,
  badRequest,
  requireWorkspaceAccess,
  publicSkill,
} from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z } from "@/lib/api/validate";
import {
  installFromRegistry,
  installFromUrl,
  installFromUpload,
  previewFromUrl,
  SkillImportError,
} from "@/lib/skills/importer";
import { listSkills } from "@/lib/skills/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;
  const skills = await listSkills(prisma, access.workspaceId);
  return Response.json({ skills: skills.map(publicSkill) });
}

interface InstallBody {
  workspaceId?: unknown;
  source?: unknown;
  packKey?: unknown;
  url?: unknown;
  sha?: unknown;
  skillMd?: unknown;
  filename?: unknown;
}

const MAX_UPLOAD_CHARS = 200_000;

const InstallBodySchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  source: z.enum(["registry", "url", "upload"]),
  packKey: z.string().trim().max(200).optional(),
  url: z.string().trim().max(2000).optional(),
  sha: z.string().trim().max(120).optional(),
  skillMd: z.string().max(MAX_UPLOAD_CHARS, `skillMd is too large (max ${MAX_UPLOAD_CHARS} characters)`).optional(),
  filename: z.string().trim().max(120).optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const rawBody = await readJsonBody<InstallBody>(req);
  const v = validateBody(InstallBodySchema, rawBody);
  if (!v.ok) return v.error;
  const body = v.data;
  const workspaceId = workspaceIdFrom(req, body);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "skills.install"))) {
    return forbidden("skills.install permission required.");
  }

  const source = body.source;
  try {
    let skill;
    if (source === "registry") {
      const packKey = body.packKey ?? "";
      if (!packKey) return badRequest("packKey is required for registry installs");
      skill = await installFromRegistry(prisma, workspaceId, packKey, user.id);
    } else if (source === "url") {
      const url = body.url ?? "";
      if (!url) return badRequest("url is required for URL installs");
      const preview = await previewFromUrl(url);
      const clientSha = body.sha ?? "";
      if (clientSha && preview.sha && clientSha !== preview.sha) {
        return Response.json(
          { error: "The skill changed since preview (SHA mismatch). Preview it again before installing.", sha: preview.sha },
          { status: 409 },
        );
      }
      skill = await installFromUrl(prisma, workspaceId, preview, url, user.id);
    } else if (source === "upload") {
      const skillMd = body.skillMd ?? "";
      if (!skillMd.trim()) return badRequest("skillMd is required for upload installs");
      const filename = body.filename?.trim() ? body.filename.trim().slice(0, 120) : "SKILL.md";
      skill = await installFromUpload(prisma, workspaceId, skillMd, filename, user.id);
    } else {
      return badRequest('source must be "registry", "url", or "upload"');
    }

    await auditEvent({
      projectId: null,
      workspaceId,
      action: "skill_installed",
      summary: `Installed skill "${skill.name}" (source=${source})`,
      actorUserId: user.id,
    });
    return Response.json({ skill: publicSkill(skill) }, { status: 201 });
  } catch (err) {
    if (err instanceof SkillImportError) return badRequest(err.message);
    throw err;
  }
}
