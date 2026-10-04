// ShapesOS — Phase 11 (bizsync): Xero tenant (organisation) selection.
//
// A Xero grant can cover several organisations. Right after the OAuth
// callback, recordXeroTenants() asks GET https://api.xero.com/connections
// which ones, keeps the list in ConnectorConnection.meta (xeroTenants, as
// JSON — non-secret ids + names) and selects the first: meta.tenantId /
// tenantName / label, and tenantId in the encrypted credential payload (the
// adapter reads it from there, like Shopify's shop and QuickBooks' realmId).
// selectXeroTenant() lets a person switch to another organisation from the
// list (Settings → Connectors → Business sync); an id outside the list is
// refused. Switching organisation does not move any exported documents —
// export rows stay keyed to the provider, so re-exporting to a NEW
// organisation needs a fresh connection.

import type { ConnectorConnection, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import { getDecryptedCredential } from "@/lib/vault/refresh";
import { tokenSourceFrom, type LiveDeps } from "@/lib/connectors/m21/live/http";
import { xeroTenants, type XeroTenant } from "./api";

export function tenantsOf(meta: unknown): XeroTenant[] {
  const raw = (meta as Record<string, unknown> | null)?.xeroTenants;
  if (typeof raw !== "string") return [];
  try {
    const list = JSON.parse(raw) as XeroTenant[];
    return Array.isArray(list) ? list.filter((t) => typeof t?.tenantId === "string") : [];
  } catch {
    return [];
  }
}

async function writeTenant(connectionId: string, meta: Record<string, unknown>, tenant: XeroTenant, list: XeroTenant[]): Promise<void> {
  const credential = await getDecryptedCredential(connectionId);
  if (credential) {
    await prisma.connectorCredential.update({
      where: { connectionId },
      data: { encryptedBlob: secrets().encrypt(JSON.stringify({ ...credential.payload, tenantId: tenant.tenantId })) },
    });
  }
  const next = { ...meta, xeroTenants: JSON.stringify(list), tenantId: tenant.tenantId, tenantName: tenant.tenantName, label: tenant.tenantName };
  delete (next as Record<string, unknown>).xeroTenantError;
  await prisma.connectorConnection.update({ where: { id: connectionId }, data: { meta: next as Prisma.InputJsonValue } });
}

/** After the OAuth callback: discover the organisations and select the first. Never throws. */
export async function recordXeroTenants(connection: ConnectorConnection, deps: LiveDeps = {}): Promise<XeroTenant[]> {
  const meta = ((connection.meta ?? {}) as Record<string, unknown>) ?? {};
  try {
    const token = tokenSourceFrom(await getDecryptedCredential(connection.id));
    if (!token) return [];
    const list = await xeroTenants(token, deps);
    if (list.length === 0) {
      await prisma.connectorConnection.update({ where: { id: connection.id }, data: { meta: { ...meta, xeroTenantError: "no Xero organisation was granted" } as Prisma.InputJsonValue } });
      return [];
    }
    const current = typeof meta.tenantId === "string" ? list.find((t) => t.tenantId === meta.tenantId) : undefined;
    await writeTenant(connection.id, meta, current ?? list[0]!, list);
    return list;
  } catch {
    await prisma.connectorConnection
      .update({ where: { id: connection.id }, data: { meta: { ...meta, xeroTenantError: "could not list Xero organisations — reconnect Xero" } as Prisma.InputJsonValue } })
      .catch(() => undefined);
    return [];
  }
}

/** A person picks the organisation for this workspace's Xero connection(s). */
export async function selectXeroTenant(workspaceId: string, tenantId: string): Promise<{ ok: true; tenantName: string } | { ok: false; error: string }> {
  const conns = await prisma.connectorConnection.findMany({ where: { workspaceId, connectorKey: "xero", status: "active" } });
  if (conns.length === 0) return { ok: false, error: "Xero is not connected in this workspace." };
  let name: string | null = null;
  for (const c of conns) {
    const list = tenantsOf(c.meta);
    const t = list.find((x) => x.tenantId === tenantId);
    if (!t) continue;
    await writeTenant(c.id, (c.meta ?? {}) as Record<string, unknown>, t, list);
    name = t.tenantName;
  }
  return name ? { ok: true, tenantName: name } : { ok: false, error: "That organisation is not one this Xero connection was granted." };
}
