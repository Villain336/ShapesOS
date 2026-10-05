// ShapesOS — Phase 11 (bizsync): the mappings a PERSON confirms in Settings →
// Connectors → Business sync (agents can't: their tools only read mappings).
//
// GET  /api/bizsync/{quickbooks|xero}?workspaceId=  → { local rows + links, remote accounts }
// GET  /api/bizsync/shopify?workspaceId=            → { Shopify locations, local locations, links }
// GET  /api/bizsync/gusto?workspaceId=              → { Gusto employees, team members, links, email suggestions } (Phase 14)
//   Admin+. Calls the provider live with the workspace's connection; 409 when
//   it isn't connected (no mock data, ever).
// POST /api/bizsync/{provider}  { workspaceId, action, … }   connectors.connect grant
//   suggest_accounts                    store code/role/name suggestions (QuickBooks / Xero)
//   confirm_accounts { entries }        confirm or clear mappings (checked against the live chart)
//   map_location { remoteLocationId, opsLocationId }   Shopify location → stock location
//   select_tenant { tenantId }          Xero organisation (only one the grant covers)
//   map_employee { remoteEmployeeId, memberId | null }   Gusto employee ↔ team
//                                       member, CONFIRMED by this person (null clears);
//                                       only confirmed links are used to pay anyone
// Each decision is recorded in the Ops audit trail.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requirePermission, requireWorkspaceRole, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest } from "@/lib/route-utils";
import { ConnectorApiError } from "@/lib/connectors/m21/live/http";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { liveConnection } from "@/lib/bizsync/connection";
import { accountingProviderFrom } from "@/lib/bizsync/accounting/providers";
import { confirmMapping, mappingRows, MappingError, saveSuggestions } from "@/lib/bizsync/accounting/mapping";
import type { AccountingProvider } from "@/lib/bizsync/accounting/types";
import { GustoLinkError } from "@/lib/bizsync/gusto/payroll";

// Phase 14 (connectors): the workspace's live Gusto connection as API auth.
async function gustoAuth(workspaceId: string, userId: string) {
  const live = await liveConnection(workspaceId, "gusto", userId);
  const { gustoAuthFrom } = await import("@/lib/connectors/m21/native/gusto");
  return gustoAuthFrom(live?.credential ?? null, { refreshCredential: live?.refreshCredential });
}

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };
const PROVIDERS = new Set(["shopify", "quickbooks", "xero", "gusto"]);
const notConnected = (label: string, why = "is not connected") =>
  Response.json({ error: `${label} ${why}. Connect it in Settings → Connectors.`, code: "not_connected" }, { status: 409 });

function providerError(err: unknown) {
  if (err instanceof ConnectorApiError) return Response.json({ error: err.message, code: err.code }, { status: err.code === "auth_rejected" ? 409 : 502 });
  if (err instanceof MappingError) return badRequest(err.message);
  if (err instanceof GustoLinkError) return Response.json({ error: err.message }, { status: 409 });
  throw err;
}

async function accounting(workspaceId: string, key: "quickbooks" | "xero", userId: string): Promise<AccountingProvider | Response> {
  const label = key === "xero" ? "Xero" : "QuickBooks";
  const live = await liveConnection(workspaceId, key, userId);
  if (!live?.credential) return notConnected(label);
  const provider = accountingProviderFrom(key, workspaceId, live.credential, { refreshCredential: live.refreshCredential });
  return provider ?? notConnected(label, key === "xero" ? "has no organisation selected" : "has no company id");
}

async function shopifyLocationsView(workspaceId: string, userId: string) {
  const live = await liveConnection(workspaceId, "shopify", userId);
  const { shopifyAuthFrom } = await import("@/lib/connectors/m21/native/shopify");
  const auth = shopifyAuthFrom(live?.credential ?? null, { refreshCredential: live?.refreshCredential });
  if (!auth) return notConnected("Shopify");
  const { shopifyLocations } = await import("@/lib/bizsync/shopify/api");
  const remote = await shopifyLocations(auth);
  const local = await withWorkspaceScope(workspaceId, async (tx) => ({
    locations: await tx.opsLocation.findMany({ where: { workspaceId, active: true }, select: { id: true, path: true, name: true }, orderBy: { path: "asc" }, take: 500 }),
    links: await tx.bizSyncLink.findMany({ where: { workspaceId, provider: "shopify", objectType: "location" }, select: { remoteId: true, localId: true } }),
  }));
  return Response.json({
    remote: remote.map((l) => ({ id: l.id, name: l.name ?? l.id, active: l.isActive !== false })),
    local: local.locations,
    links: local.links,
  });
}

export async function GET(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { provider } = await params;
  if (!PROVIDERS.has(provider)) return Response.json({ error: "Unknown provider" }, { status: 404 });
  const workspaceId = workspaceIdFrom(req);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requireWorkspaceRole(user.id, workspaceId, "admin"))) return forbidden("Admin role required.");
  try {
    if (provider === "shopify") return await shopifyLocationsView(workspaceId, user.id);
    if (provider === "gusto") {
      const auth = await gustoAuth(workspaceId, user.id);
      if (!auth) return notConnected("Gusto");
      const { gustoEmployeeView } = await import("@/lib/bizsync/gusto/payroll");
      return Response.json(await gustoEmployeeView(workspaceId, auth));
    }
    const p = await accounting(workspaceId, provider as "quickbooks" | "xero", user.id);
    if (p instanceof Response) return p;
    const [remote, rows] = await Promise.all([p.listAccounts(), mappingRows(workspaceId, provider as "quickbooks" | "xero")]);
    return Response.json({ remote, rows });
  } catch (err) {
    return providerError(err);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { provider } = await params;
  if (!PROVIDERS.has(provider)) return Response.json({ error: "Unknown provider" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const workspaceId = workspaceIdFrom(req, body);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "connectors.connect"))) return forbidden("connectors.connect permission required.");
  const action = String(body?.action ?? "");
  try {
    if (provider === "shopify") {
      if (action !== "map_location") return badRequest("Unknown action for Shopify");
      const remoteLocationId = String(body?.remoteLocationId ?? "");
      const opsLocationId = String(body?.opsLocationId ?? "");
      if (!/^gid:\/\/shopify\/Location\/\d+$/.test(remoteLocationId) || !opsLocationId) return badRequest("remoteLocationId and opsLocationId are required");
      const { setLocationMapping } = await import("@/lib/bizsync/shopify/sync");
      const r = await setLocationMapping(workspaceId, remoteLocationId, opsLocationId, user.id);
      return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: 409 });
    }
    if (provider === "gusto") {
      if (action !== "map_employee") return badRequest("Unknown action for Gusto");
      const remoteEmployeeId = String(body?.remoteEmployeeId ?? "");
      const memberId = body?.memberId === null ? null : String(body?.memberId ?? "");
      if (!/^[A-Za-z0-9-]{8,64}$/.test(remoteEmployeeId) || memberId === "") return badRequest("remoteEmployeeId and memberId (or null to clear) are required");
      const auth = await gustoAuth(workspaceId, user.id);
      if (!auth) return notConnected("Gusto");
      const { gustoEmployees } = await import("@/lib/bizsync/gusto/api");
      const { setGustoEmployeeLink } = await import("@/lib/bizsync/gusto/payroll");
      const emps = await gustoEmployees(auth);
      return Response.json(await setGustoEmployeeLink(workspaceId, remoteEmployeeId, memberId, user.id, emps.items));
    }
    const key = provider as "quickbooks" | "xero";
    if (action === "select_tenant") {
      if (key !== "xero") return badRequest("Only Xero has organisations to choose");
      const { selectXeroTenant } = await import("@/lib/bizsync/xero/tenants");
      const r = await selectXeroTenant(workspaceId, String(body?.tenantId ?? ""), user.id);
      return r.ok ? Response.json(r) : Response.json({ error: r.error }, { status: 409 });
    }
    if (action !== "suggest_accounts" && action !== "confirm_accounts") return badRequest("Unknown action");
    const p = await accounting(workspaceId, key, user.id);
    if (p instanceof Response) return p;
    const remote = await p.listAccounts();
    if (action === "suggest_accounts") {
      const suggested = await saveSuggestions(workspaceId, key, remote);
      return Response.json({ suggested, rows: await mappingRows(workspaceId, key) });
    }
    const raw = Array.isArray(body?.entries) ? (body!.entries as Array<Record<string, unknown>>) : [];
    if (raw.length === 0 || raw.length > 500) return badRequest("entries must list 1–500 accounts");
    const entries = raw.map((e) => ({ accountId: String(e.accountId ?? ""), remoteAccountId: e.remoteAccountId === null ? null : String(e.remoteAccountId ?? "") }));
    const result = await confirmMapping(workspaceId, key, entries, remote, user.id);
    return Response.json({ ...result, rows: await mappingRows(workspaceId, key) });
  } catch (err) {
    return providerError(err);
  }
}
