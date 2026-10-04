// Marketr — Phase 17 slice 1: GET/POST/PATCH /api/ops/{entity}.
//
// ONE route file serves every Operations entity — that IS the DocType
// convention: an entity plugs in by adding one entry to
// lib/ops/entities.ts, and the REST API + workspace scoping + audit +
// Phase 14 money-gate come by construction (lib/ops/doctype.ts).
//
// Permissions by construction: reads need viewer+, mutations need editor+
// (workspace role). Money writes additionally need an approved Phase 14
// ops approval (see lib/ops/gate.ts) — without one the service proposes it
// and answers 202 { approval_required: true }.

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP, OPS_ENTITY_SLUGS } from "@/lib/ops/entities";
import {
  OpsError,
  OpsGateError,
  opsCreate,
  opsEntityDef,
  opsList,
  opsPatch,
  type OpsActor,
} from "@/lib/ops/doctype";
import { errorResponse } from "@/lib/api/errors";
import { intQuery, parseQuery, z } from "@/lib/api/validate";
import { emitInvoicePaid } from "@/lib/webhooks/emit";
// Phase 10 (finance): post-commit email delivery of sent invoices / quotes.
import { deliverAfterSend } from "@/lib/ops/finance/after-commit";

export const dynamic = "force-dynamic";

type Role = "viewer" | "editor" | "admin";

async function opsGuard(min: Role): Promise<OpsActor | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (min !== "viewer" && !(await requireWorkspaceRole(user.id, workspace.id, min))) {
    return Response.json({ error: `Forbidden: ${min} role required` }, { status: 403 });
  }
  return { userId: user.id, workspaceId: workspace.id };
}

// Phase 12 (people): an entity may raise its minimum role (payroll is
// admin-only); unknown slugs fall through to the default and 404 below.
function roleFor(entity: string, op: "read" | "write"): Role {
  const def = OPS_ENTITY_MAP[entity];
  return op === "read" ? def?.readRole ?? "viewer" : def?.writeRole ?? "editor";
}

function opsError(err: unknown) {
  if (err instanceof OpsError) return Response.json({ error: err.message }, { status: err.status });
  // Fail closed: gate bypass attempts are 422, never silent.
  if (err instanceof OpsGateError) {
    return Response.json({ error: err.message, code: err.code }, { status: 422 });
  }
  return errorResponse(err);
}

async function readJson(req: NextRequest): Promise<unknown> {
  try {
    const text = await req.text();
    return text.trim() ? (JSON.parse(text) as unknown) : {};
  } catch {
    return { __invalid: true };
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ entity: string }> },
) {
  const { entity } = await params;
  const gate = await opsGuard(roleFor(entity, "read"));
  if (gate instanceof Response) return gate;
  try {
    const def = opsEntityDef(entity);
    const q = req.nextUrl.searchParams;
    const limitQuery = parseQuery(z.object({ limit: intQuery(50, 1, 200) }), q);
    if (!limitQuery.ok) return limitQuery.error;
    const limit = limitQuery.data.limit;
    const filters: Record<string, string> = {};
    for (const f of def.filterable) {
      const v = q.get(f);
      if (v) filters[f] = v;
    }
    const result = await withWorkspaceScope(gate.workspaceId, (tx) =>
      opsList(tx, def, gate, { limit, filters }),
    );
    return Response.json(result);
  } catch (err) {
    return opsError(err);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ entity: string }> },
) {
  const { entity } = await params;
  const gate = await opsGuard(roleFor(entity, "write"));
  if (gate instanceof Response) return gate;
  try {
    const def = opsEntityDef(entity);
    const body = await readJson(req);
    if (body && typeof body === "object" && "__invalid" in (body as Record<string, unknown>)) {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const result = await withWorkspaceScope(gate.workspaceId, (tx) =>
      opsCreate(tx, def, gate, body),
    );
    if (result.outcome === "approval_required") {
      return Response.json(
        {
          approval_required: true,
          approval: result.approval,
          classification: result.classification,
          entities: OPS_ENTITY_SLUGS,
        },
        { status: 202 },
      );
    }
    // Phase 12 (people): a confirmed staff registration enrolls the
    // registrant in the event's reminder sequence after the commit.
    if (def.slug === "event-registrations" && result.row.status === "confirmed") {
      const { afterConfirmed } = await import("@/lib/ops/events/registrations");
      await afterConfirmed(gate.workspaceId, String(result.row.id));
    }
    // A reused invoice idempotency key returns the original row (200).
    return Response.json(
      { entity: def.slug, row: result.row },
      { status: result.action === "idempotent_replay" ? 200 : 201 },
    );
  } catch (err) {
    return opsError(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ entity: string }> },
) {
  const { entity } = await params;
  const gate = await opsGuard(roleFor(entity, "write"));
  if (gate instanceof Response) return gate;
  try {
    const def = opsEntityDef(entity);
    const body = await readJson(req);
    if (body && typeof body === "object" && "__invalid" in (body as Record<string, unknown>)) {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const result = await withWorkspaceScope(gate.workspaceId, (tx) =>
      opsPatch(tx, def, gate, body),
    );
    if (result.outcome === "approval_required") {
      return Response.json(
        {
          approval_required: true,
          approval: result.approval,
          classification: result.classification,
        },
        { status: 202 },
      );
    }
    // Phase 4a: invoice.paid webhook once a patch lands an invoice on paid
    // (after the scoped transaction commits; best-effort, never throws).
    const row = result.row as Record<string, unknown> | undefined;
    if (def.slug === "invoices" && row && row.status === "paid" && (body as Record<string, unknown>)?.status === "paid") {
      await emitInvoicePaid(gate.workspaceId, row);
    }
    // Phase 10 (finance): an approved send emails the document with its PDF
    // AFTER the send committed (best-effort; the outcome is recorded on it).
    const delivery = await deliverAfterSend(gate, def.slug, row, body);
    return Response.json({ entity: def.slug, row: result.row, ...(delivery ? { delivery } : {}) });
  } catch (err) {
    return opsError(err);
  }
}
