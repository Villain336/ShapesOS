// Marketr — API-key connector connect (milestone 21).
// POST /api/connectors/[key]/api-key { workspaceId, apiKey, label? }
//   → { connection: { id, status } }
// Stores the key encrypted via the vault (never returned). Admin+ or
// connectors.connect grant. Audited (connector_connected).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { readJsonBody } from "@/lib/sitefiles/api";
import { validateBody, z } from "@/lib/api/validate";
import { storeApiKey } from "@/lib/vault/apikey";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  // NOTE: apiKey is intentionally NOT trimmed — keys are opaque and whitespace
  // may be significant. Length-capped to bound vault input.
  apiKey: z.string().min(1, "apiKey is required").max(8000, "apiKey is too long"),
  label: z.string().trim().max(120).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  const rawBody = await readJsonBody(req);
  const v = validateBody(BodySchema, rawBody);
  if (!v.ok) return v.error;
  const body = v.data;
  const workspaceId = workspaceIdFrom(req, body);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "connectors.connect"))) {
    return forbidden("connectors.connect permission required.");
  }
  const apiKey = body.apiKey;
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
