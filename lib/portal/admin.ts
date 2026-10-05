// ShapesOS — Phase 10 (portal): Settings → Clients → Portal access.
//
// Admins turn a client's portal on or off, choose which CRM records the
// client sees (companies, contacts, leads — see lib/portal/core.ts
// portalScope) and see / revoke the client's portal sessions. Every write is
// audited in the workspace audit log (client_updated). Turning the portal
// off revokes every live portal session at once.

import { prisma } from "@/lib/prisma";
import { BadRequestError, NotFoundError } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { cleanLinkIds, portalSections, type PortalSection } from "./core";
import { listPortalSessions, revokePortalSessions, type PortalSessionView } from "./store";

export interface PortalRecordRef {
  id: string;
  name: string;
  detail: string | null;
}

export interface ClientPortalAdmin {
  client: { id: string; name: string; loginEmail: string; viewerRole: string; portalEnabled: boolean };
  sections: PortalSection[];
  linked: { companies: PortalRecordRef[]; contacts: PortalRecordRef[]; leads: PortalRecordRef[] };
  candidates: { companies: PortalRecordRef[]; contacts: PortalRecordRef[]; leads: PortalRecordRef[] };
  sessions: PortalSessionView[];
}

async function loadClient(workspaceId: string, clientId: string) {
  const c = await prisma.client.findFirst({ where: { id: clientId, workspaceId } });
  if (!c) throw new NotFoundError("Client not found.");
  return c;
}

const CANDIDATE_LIMIT = 300;

export async function getClientPortalAdmin(workspaceId: string, clientId: string): Promise<ClientPortalAdmin> {
  const c = await loadClient(workspaceId, clientId);
  const { linked, candidates } = await withWorkspaceScope(workspaceId, async (tx) => {
    const [companies, contacts, leads, linkedCompanies, linkedContacts, linkedLeads] = await Promise.all([
      tx.opsCompany.findMany({ where: { workspaceId }, orderBy: { name: "asc" }, take: CANDIDATE_LIMIT, select: { id: true, name: true, domain: true } }),
      tx.opsContact.findMany({
        where: { workspaceId },
        orderBy: { name: "asc" },
        take: CANDIDATE_LIMIT,
        select: { id: true, name: true, email: true, company: { select: { name: true } } },
      }),
      tx.lead.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: CANDIDATE_LIMIT, select: { id: true, name: true, email: true, company: true } }),
      tx.opsCompany.findMany({ where: { workspaceId, id: { in: c.portalCompanyIds } }, select: { id: true, name: true, domain: true } }),
      tx.opsContact.findMany({
        where: { workspaceId, id: { in: c.portalContactIds } },
        select: { id: true, name: true, email: true, company: { select: { name: true } } },
      }),
      tx.lead.findMany({ where: { workspaceId, id: { in: c.portalLeadIds } }, select: { id: true, name: true, email: true, company: true } }),
    ]);
    const co = (x: { id: string; name: string; domain: string | null }): PortalRecordRef => ({ id: x.id, name: x.name, detail: x.domain });
    const ct = (x: { id: string; name: string; email: string | null; company: { name: string } | null }): PortalRecordRef => ({
      id: x.id,
      name: x.name,
      detail: [x.email, x.company?.name].filter(Boolean).join(" · ") || null,
    });
    const ld = (x: { id: string; name: string; email: string | null; company: string | null }): PortalRecordRef => ({
      id: x.id,
      name: x.name,
      detail: [x.email, x.company].filter(Boolean).join(" · ") || null,
    });
    return {
      linked: { companies: linkedCompanies.map(co), contacts: linkedContacts.map(ct), leads: linkedLeads.map(ld) },
      candidates: { companies: companies.map(co), contacts: contacts.map(ct), leads: leads.map(ld) },
    };
  });
  return {
    client: { id: c.id, name: c.name, loginEmail: c.loginEmail, viewerRole: c.viewerRole, portalEnabled: c.portalEnabled },
    sections: portalSections(c.viewerRole),
    linked,
    candidates,
    sessions: await listPortalSessions(workspaceId, clientId),
  };
}

export interface ClientPortalInput {
  portalEnabled?: unknown;
  companyIds?: unknown;
  contactIds?: unknown;
  leadIds?: unknown;
}

/** Validate and save the portal switch + links (every id must be this workspace's). */
export async function updateClientPortal(workspaceId: string, actorUserId: string, clientId: string, input: ClientPortalInput) {
  const c = await loadClient(workspaceId, clientId);
  const data: { portalEnabled?: boolean; portalCompanyIds?: string[]; portalContactIds?: string[]; portalLeadIds?: string[] } = {};
  if (input.portalEnabled !== undefined) {
    if (typeof input.portalEnabled !== "boolean") throw new BadRequestError("portalEnabled must be true or false.");
    data.portalEnabled = input.portalEnabled;
  }
  try {
    if (input.companyIds !== undefined) data.portalCompanyIds = cleanLinkIds(input.companyIds, "companies");
    if (input.contactIds !== undefined) data.portalContactIds = cleanLinkIds(input.contactIds, "contacts");
    if (input.leadIds !== undefined) data.portalLeadIds = cleanLinkIds(input.leadIds, "leads");
  } catch (e) {
    throw new BadRequestError((e as Error).message);
  }
  await withWorkspaceScope(workspaceId, async (tx) => {
    const check = async (ids: string[] | undefined, count: () => Promise<number>, what: string) => {
      if (ids?.length && (await count()) !== ids.length) throw new BadRequestError(`Unknown ${what}: pick ${what} from this workspace.`);
    };
    await check(data.portalCompanyIds, () => tx.opsCompany.count({ where: { workspaceId, id: { in: data.portalCompanyIds! } } }), "companies");
    await check(data.portalContactIds, () => tx.opsContact.count({ where: { workspaceId, id: { in: data.portalContactIds! } } }), "contacts");
    await check(data.portalLeadIds, () => tx.lead.count({ where: { workspaceId, id: { in: data.portalLeadIds! } } }), "leads");
  });
  if (Object.keys(data).length === 0) return { id: c.id, revoked: 0 };
  await prisma.client.update({ where: { id: c.id, workspaceId }, data });
  let revoked = 0;
  if (data.portalEnabled === false && c.portalEnabled) {
    revoked = await revokePortalSessions(workspaceId, c.id, actorUserId, { reason: "portal turned off" });
  }
  const parts: string[] = [];
  if (data.portalEnabled !== undefined && data.portalEnabled !== c.portalEnabled) parts.push(`portal ${data.portalEnabled ? "on" : "off"}`);
  if (data.portalCompanyIds) parts.push(`${data.portalCompanyIds.length} compan${data.portalCompanyIds.length === 1 ? "y" : "ies"}`);
  if (data.portalContactIds) parts.push(`${data.portalContactIds.length} contact${data.portalContactIds.length === 1 ? "" : "s"}`);
  if (data.portalLeadIds) parts.push(`${data.portalLeadIds.length} lead${data.portalLeadIds.length === 1 ? "" : "s"}`);
  await prisma.fileChangeLog.create({
    data: {
      workspaceId,
      filePath: "(workspace)",
      actor: "user",
      action: "client_updated",
      summary: `Client "${c.name}" portal access updated (${parts.join(", ") || "no change"})`,
      approvedBy: actorUserId,
    },
  });
  return { id: c.id, revoked };
}

/** Revoke one portal session (sessionId) or all of a client's live sessions. */
export async function revokeClientPortalSessions(workspaceId: string, actorUserId: string, clientId: string, sessionId?: unknown) {
  await loadClient(workspaceId, clientId);
  if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId || sessionId.length > 64)) {
    throw new BadRequestError("sessionId must be a session id.");
  }
  return revokePortalSessions(workspaceId, clientId, actorUserId, { sessionId: sessionId as string | undefined, reason: "revoked in Settings → Clients" });
}
