// Marketr — typed-in credential connect (milestone 21; Phase 14 field schemas).
// POST /api/connectors/[key]/api-key
//   { workspaceId, mode?, fields: { <name>: value, … }, label? }
//   (legacy { workspaceId, apiKey, label? } still works when the mode has an
//   apiKey field)
//   → 201 { connection: { id, status }, warnings? }
// Phase 14 (connectors): each connector declares its credential fields in the
// registry (lib/connectors/m21/credential-fields.ts): WordPress site URL +
// username + application password, DataForSEO login + password, Shopify
// store domain + client ID/secret (or an existing custom app's token), and
// single-key connectors unchanged. The route refuses connectors that don't
// take typed-in credentials (OAuth-only, no-auth), validates the fields, and
// stores EXACTLY the declared fields, encrypted via the vault (never
// returned). Shopify is validated against the store first (token request +
// one GraphQL call) and wired to the per-connection webhook secret.
// Admin+ or connectors.connect grant. Audited (connector_connected).
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
import { storeCredentialPayload } from "@/lib/vault/apikey";
import { prisma } from "@/lib/prisma";
import { getBuiltinMeta, isBuiltinKey } from "@/lib/connectors/m21/registry";
import { parseCredentialFields } from "@/lib/connectors/m21/credential-fields";
import { ConnectorApiError } from "@/lib/connectors/m21/live/http";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  // NOTE: apiKey is intentionally NOT trimmed — keys are opaque and whitespace
  // may be significant. Length-capped to bound vault input.
  apiKey: z.string().min(1, "apiKey is required").max(8000, "apiKey is too long").optional(),
  label: z.string().trim().max(120).optional(),
  // Phase 14: the connector's credential mode + its declared fields.
  mode: z.string().trim().max(60).optional(),
  fields: z.record(z.string(), z.string().max(8000, "a field is too long")).optional(),
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
  // Phase 14: only built-in connectors that take typed-in credentials.
  if (!isBuiltinKey(key)) return Response.json({ error: `Unknown connector "${key.slice(0, 60)}"` }, { status: 404 });
  const meta = getBuiltinMeta(key);
  const parsed = parseCredentialFields(meta, { mode: body.mode ?? null, fields: body.fields ?? null, legacyApiKey: body.apiKey ?? null });
  if (!parsed.ok) return badRequest(parsed.error);
  try {
    // Shopify: validate against the store and wire the webhook secret.
    if (key === "shopify") {
      const { connectShopifySingleStore } = await import("@/lib/bizsync/shopify/single-store");
      const r = await connectShopifySingleStore({
        userId: user.id,
        workspaceId,
        mode: parsed.mode.id === "admin_token" ? "admin_token" : "client_credentials",
        values: parsed.values,
        label: body.label ?? null,
      });
      await auditEvent({
        projectId: null,
        workspaceId,
        action: "connector_connected",
        summary: `Connected shopify (single store, ${parsed.mode.label.toLowerCase()}: ${r.label})`.slice(0, 500),
        actorUserId: user.id,
      });
      return Response.json({ connection: { id: r.connection.id, status: r.connection.status }, warnings: r.warnings }, { status: 201 });
    }
    const label = body.label?.trim() ? body.label.trim().slice(0, 120) : meta.displayName;
    const connection = await storeCredentialPayload(user.id, workspaceId, key, label, parsed.values);
    await auditEvent({
      projectId: null,
      workspaceId,
      action: "connector_connected",
      summary: `Connected ${key} (${parsed.mode.label.toLowerCase()}, label "${label}")`,
      actorUserId: user.id,
    });
    return Response.json({ connection: { id: connection.id, status: connection.status } }, { status: 201 });
  } catch (err) {
    if (err instanceof ConnectorApiError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.code === "provider_unreachable" || err.code === "provider_error" ? 502 : 400 });
    }
    return badRequest(err instanceof Error ? err.message : "Could not store the credential");
  }
}
