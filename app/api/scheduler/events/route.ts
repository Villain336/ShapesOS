// Marketr — scheduler event injection API (Phase B, W2).
// POST /api/scheduler/events { workspaceId, projectId?, source, payload }
//   → { accepted, fired, skipped }.
//
// Two actors: the CRON_SECRET service call (detectors, any workspace) or a
// signed-in editor+ session on the target workspace (threat model T5: event
// payload spoofing). Payloads are zod-validated against per-source schemas;
// lineage is server-side only and cannot be set here.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { validateBody, z } from "@/lib/api/validate";
import { readJsonBody } from "@/lib/sitefiles/api";
import { injectEvent } from "@/lib/scheduler/service";
import { bearerMatches } from "@/lib/security/constant-time";

export const dynamic = "force-dynamic";

const InjectSchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  projectId: z.string().trim().max(120).nullable().optional(),
  source: z.string().trim().min(1).max(60),
  payload: z.record(z.string(), z.unknown()),
});

export async function POST(req: NextRequest) {
  // Phase 1: authenticate BEFORE parsing/validating the body, so anonymous
  // callers learn nothing about the schema; the secret compare is
  // constant-time. CRON_SECRET service path (recognized by the M11 scan) or
  // an editor+ session.
  const secret = (process.env.CRON_SECRET ?? "").trim();
  const isService = bearerMatches(req.headers.get("authorization"), secret);
  const user = isService ? null : await requireUser();
  if (!isService && !user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonBody(req);
  const validated = validateBody(InjectSchema, body);
  if (!validated.ok) return validated.error;
  const input = validated.data;

  let workspaceId: string;
  if (isService) {
    workspaceId = input.workspaceId?.trim() || "";
    if (!workspaceId) return badRequest("workspaceId is required");
  } else {
    const access = await requireWorkspaceAccess(user!.id, workspaceIdFrom(req, input), "editor");
    if ("error" in access) return access.error;
    workspaceId = access.workspaceId;
  }

  const result = await injectEvent(prisma, {
    workspaceId,
    projectId: input.projectId,
    source: input.source,
    payload: input.payload,
    actorId: null,
  });
  if (!result.accepted) return badRequest(result.error ?? "Event rejected");
  return Response.json(result, { status: 201 });
}
