// Marketr — API-key connector connect (milestone 21).
// POST /api/connectors/[key]/api-key { workspaceId, apiKey, label? }
//   → { connection: { id, status } }
// Stores the key encrypted via the vault (never returned). Admin+ or
// connectors.connect grant. Audited (connector_connected).
// Phase 11 (devtools): POST /api/connectors/netlify/api-key
//   { hostingConnectionId, workspaceId?, label? } connects the Netlify
//   connector to an existing Netlify hosting connection instead of a new
//   token: the vault stores only the reference; the workspace is the hosting
//   connection's own (a workspaceId that disagrees is refused).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z } from "@/lib/api/validate";
import { storeApiKey, storeCredentialPayload } from "@/lib/vault/apikey";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  // NOTE: apiKey is intentionally NOT trimmed — keys are opaque and whitespace
  // may be significant. Length-capped to bound vault input.
  apiKey: z.string().min(1, "apiKey is required").max(8000, "apiKey is too long").optional(),
  label: z.string().trim().max(120).optional(),
  // Phase 11 (devtools): Netlify only — reuse a hosting connection's token.
  hostingConnectionId: z.string().trim().min(1).max(120).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  const rawBody = await readJsonBody(req);
  const v = validateBody(BodySchema, rawBody);
  if (!v.ok) return v.error;
  const body = v.data;
  // Phase 11 (devtools): Netlify from an existing hosting connection.
  if (body.hostingConnectionId !== undefined) {
    if (key !== "netlify") return badRequest("hostingConnectionId is only supported for the Netlify connector");
    const hosting = await prisma.hostingConnection.findFirst({
      where: { id: body.hostingConnectionId, target: "netlify" },
      select: { id: true, name: true, project: { select: { workspaceId: true } } },
    });
    const requested = workspaceIdFrom(req, body);
    if (!hosting || (requested && requested !== hosting.project.workspaceId)) return badRequest("Netlify hosting connection not found");
    const hostingWorkspaceId = hosting.project.workspaceId;
    // Same answer as "not found" so a hosting connection id outside your reach reveals nothing.
    if (!(await requirePermission(user.id, hostingWorkspaceId, "connectors.connect"))) {
      return badRequest("Netlify hosting connection not found");
    }
    const hostingLabel = body.label?.trim() ? body.label.trim().slice(0, 120) : hosting.name.slice(0, 120);
    const connection = await storeCredentialPayload(user.id, hostingWorkspaceId, key, hostingLabel, { hostingConnectionId: hosting.id });
    await auditEvent({
      projectId: null,
      workspaceId: hostingWorkspaceId,
      action: "connector_connected",
      summary: `Connected ${key} (hosting connection "${hostingLabel}")`,
      actorUserId: user.id,
    });
    return Response.json({ connection: { id: connection.id, status: connection.status } }, { status: 201 });
  }
  const workspaceId = workspaceIdFrom(req, body);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "connectors.connect"))) {
    return forbidden("connectors.connect permission required.");
  }
  const apiKey = body.apiKey ?? "";
  if (!apiKey.trim()) return badRequest("apiKey is required");
  const label = body.label?.trim() ? body.label.trim().slice(0, 120) : key;
  try {
    const connection = await storeApiKey(user.id, workspaceId, key, label, apiKey);
    await auditEvent({
      projectId: null,
      workspaceId,
      action: "connector_connected",
      summary: `Connected ${key} (API key, label "${label}")`,
      actorUserId: user.id,
    });
    return Response.json({ connection: { id: connection.id, status: connection.status } }, { status: 201 });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Could not store API key");
  }
}
